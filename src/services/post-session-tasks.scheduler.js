const TimetableSlot = require("../models/TimetableSlot");
const MentorSlot = require("../models/MentorSlot");
const {
  parseSlotEnd,
  formatDateYmdInClassTimeZone,
} = require("../utils/timetable-slot-start");
const {
  getPostSessionTasksCutoff,
  isSessionEndEligibleForPostTasks,
} = require("../utils/post-session-tasks-config");
const { resolveRecordingDestination } = require("./recording-destination.service");
const {
  notifyInstructorsForSlot,
  buildPostClassTasksEmail,
  fmtWhenLocal,
  INSTRUCTOR_ASSIGNMENTS_ACTION,
} = require("./instructor-notifications.service");
const { notifySchedulingAlertRecipients } = require("./scheduling-alert-recipients.service");
const {
  parseMentorSessionEnd,
  formatMentorWhen,
  isMentorSlotPublished,
  buildMentorPostSessionTasksEmail,
  MENTOR_SESSION_ACTION,
} = require("./mentor-slot-lifecycle.service");
const { resolveMentorRecipients } = require("./mentor-notification.service");
const { emitEventNotification } = require("./staffPanelNotification.service");
const { sendSimpleEmail } = require("./brevo");

/** Retry window: re-check ended sessions from the last 7 calendar days in class TZ. */
const LOOKBACK_DAYS = 7;

const pendingTasksRevisionExpr = {
  $ne: [
    { $ifNull: ["$post_class_tasks_sent_schedule_revision", -1] },
    { $ifNull: ["$schedule_revision", 1] },
  ],
};

const pendingMentorTasksRevisionExpr = {
  $ne: [
    { $ifNull: ["$post_session_tasks_sent_schedule_revision", -1] },
    { $ifNull: ["$schedule_revision", 1] },
  ],
};

function lookbackClassDates(now) {
  const dates = [];
  for (let i = 0; i <= LOOKBACK_DAYS; i += 1) {
    const d = formatDateYmdInClassTimeZone(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    if (d) dates.push(d);
  }
  return [...new Set(dates)];
}

function destinationStatusLabel(status) {
  if (status === "missing") return "recording folder not configured";
  if (status === "ambiguous") return "ambiguous multi-batch recording destination";
  if (status === "invalid_slot") return "invalid batch targeting";
  if (status === "batch_not_found") return "batch not found";
  return String(status || "unknown");
}

async function maybeAlertTimetableDestinationIssue(slot, destination, scheduleRevision) {
  const rev = scheduleRevision;
  if (Number(slot.post_class_destination_alerted_schedule_revision) === rev) return;

  const claimed = await TimetableSlot.updateOne(
    {
      _id: slot._id,
      $or: [
        { post_class_destination_alerted_schedule_revision: null },
        { post_class_destination_alerted_schedule_revision: { $ne: rev } },
      ],
    },
    { $set: { post_class_destination_alerted_schedule_revision: rev } }
  );
  if (claimed.modifiedCount !== 1) return;

  const slotId = String(slot._id);
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const statusLabel = destinationStatusLabel(destination.status);
  const batchLine = slot.batch_id || "N/A";
  const sectionLine = slot.section_id || "All";
  const destDetail =
    destination.status === "ambiguous" && Array.isArray(destination.destinations)
      ? destination.destinations
          .map((d) => `${d.batch_id}: ${d.status === "ok" ? "configured" : d.status}`)
          .join("; ")
      : "";

  try {
    const result = await notifySchedulingAlertRecipients({
      event_type: "timetable_post_class_destination_issue",
      dedupeKeyPrefix: `timetable_post_class_destination:${slotId}:${rev}:${destination.status}`,
      title: "Post-class recording folder issue",
      panelMessage: `Cannot send post-class upload task for ${slot.subject || "class"} (${whenText}) — ${statusLabel}. Batch: ${batchLine}, Section: ${sectionLine}.${destDetail ? ` Details: ${destDetail}.` : ""} Configure the batch recording folder in Batch Hub.`,
      action_url: "/batches",
      email: (recipient) => ({
        subject: `Action required: post-class recording folder (${slot.subject || "Class"})`,
        htmlContent: `<div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Post-class recording folder issue</h2>
          <p>Hello ${recipient.name || "Scheduling team"},</p>
          <p>A class has ended but the instructor post-class upload task could not be sent because the recording destination is not usable (<strong>${statusLabel}</strong>).</p>
          <ul>
            <li><strong>Subject:</strong> ${slot.subject || "N/A"}</li>
            <li><strong>When:</strong> ${whenText}</li>
            <li><strong>Batch:</strong> ${batchLine}</li>
            <li><strong>Section:</strong> ${sectionLine}</li>
            ${destDetail ? `<li><strong>Batch destinations:</strong> ${destDetail}</li>` : ""}
          </ul>
          <p>Configure the batch recording upload folder in <strong>Batches</strong> and the task will retry automatically.</p>
        </div>`,
        textContent: [
          "Post-class recording folder issue.",
          `Subject: ${slot.subject || "N/A"}`,
          `When: ${whenText}`,
          `Batch: ${batchLine}`,
          `Section: ${sectionLine}`,
          destDetail ? `Details: ${destDetail}` : null,
          `Problem: ${statusLabel}`,
          "Configure the batch recording folder in Batch Hub.",
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    });

    if (!result.ok) {
      await TimetableSlot.updateOne(
        { _id: slot._id },
        { $set: { post_class_destination_alerted_schedule_revision: null } }
      );
    }
  } catch (e) {
    await TimetableSlot.updateOne(
      { _id: slot._id },
      { $set: { post_class_destination_alerted_schedule_revision: null } }
    ).catch(() => {});
    console.error("[TIMETABLE_POST_CLASS_DEST_ALERT_FAILED]", e?.message || e);
  }
}

async function maybeAlertMentorDestinationIssue(slot, destination, scheduleRevision) {
  const rev = scheduleRevision;
  if (Number(slot.post_session_destination_alerted_schedule_revision) === rev) return;

  const claimed = await MentorSlot.updateOne(
    {
      _id: slot._id,
      $or: [
        { post_session_destination_alerted_schedule_revision: null },
        { post_session_destination_alerted_schedule_revision: { $ne: rev } },
      ],
    },
    { $set: { post_session_destination_alerted_schedule_revision: rev } }
  );
  if (claimed.modifiedCount !== 1) return;

  const slotId = String(slot._id);
  const whenText = formatMentorWhen(slot);
  const statusLabel = destinationStatusLabel(destination.status);
  const batchLine =
    Array.isArray(slot.target_batch_ids) && slot.target_batch_ids.length
      ? slot.target_batch_ids.join(", ")
      : "N/A";
  const destDetail =
    Array.isArray(destination.destinations) && destination.destinations.length
      ? destination.destinations
          .map((d) => `${d.batch_id}: ${d.status === "ok" ? "configured" : d.status}`)
          .join("; ")
      : "";

  try {
    const result = await notifySchedulingAlertRecipients({
      event_type: "mentor_post_session_destination_issue",
      dedupeKeyPrefix: `mentor_post_session_destination:${slotId}:${rev}:${destination.status}`,
      title: "Post-session recording folder issue",
      panelMessage: `Cannot send mentor post-session upload task for ${slot.mentor_name || "mentor"} (${whenText}) — ${statusLabel}. Batch: ${batchLine}.${destDetail ? ` Details: ${destDetail}.` : ""} Configure the batch recording folder in Batch Hub.`,
      action_url: "/mentor-slots",
      email: (recipient) => ({
        subject: `Action required: mentor session recording folder (${slot.mentor_name || "Mentor"})`,
        htmlContent: `<div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Post-session recording folder issue</h2>
          <p>Hello ${recipient.name || "Scheduling team"},</p>
          <p>A mentor session has ended but the post-session upload task could not be sent because the recording destination is not usable (<strong>${statusLabel}</strong>).</p>
          <ul>
            <li><strong>Mentor:</strong> ${slot.mentor_name || "N/A"}</li>
            <li><strong>When:</strong> ${whenText}</li>
            <li><strong>Batch:</strong> ${batchLine}</li>
            ${destDetail ? `<li><strong>Batch destinations:</strong> ${destDetail}</li>` : ""}
          </ul>
          <p>Configure the batch recording upload folder in <strong>Batches</strong> and the task will retry automatically.</p>
        </div>`,
        textContent: [
          "Post-session recording folder issue.",
          `Mentor: ${slot.mentor_name || "N/A"}`,
          `When: ${whenText}`,
          `Batch: ${batchLine}`,
          destDetail ? `Details: ${destDetail}` : null,
          `Problem: ${statusLabel}`,
          "Configure the batch recording folder in Batch Hub.",
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    });

    if (!result.ok) {
      await MentorSlot.updateOne(
        { _id: slot._id },
        { $set: { post_session_destination_alerted_schedule_revision: null } }
      );
    }
  } catch (e) {
    await MentorSlot.updateOne(
      { _id: slot._id },
      { $set: { post_session_destination_alerted_schedule_revision: null } }
    ).catch(() => {});
    console.error("[MENTOR_POST_SESSION_DEST_ALERT_FAILED]", e?.message || e);
  }
}

async function sendTimetablePostClassTasks(slot, driveFolderUrl, scheduleRevision) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const sectionLine = slot.section_id || "All";
  const panelMessage = [
    `Your class ${slot.subject || "Class"} has ended (${whenText}).`,
    `1) Upload the recording to: ${driveFolderUrl}`,
    "2) Create/add the assignment for this class in CodeMasti.",
    `Batch: ${slot.batch_id || "N/A"}, Section: ${sectionLine}.`,
  ].join(" ");

  const slotId = String(slot._id);
  const dedupeBase = `timetable_post_class_tasks:${slotId}:${scheduleRevision}`;

  const { notified } = await notifyInstructorsForSlot({
    slot,
    event_type: "timetable_post_class_tasks",
    title: "Class ended — upload recording & add assignment",
    message: panelMessage,
    action_url: INSTRUCTOR_ASSIGNMENTS_ACTION,
    dedupe_key: dedupeBase,
    emailBuilder: ({ staff }) =>
      buildPostClassTasksEmail({
        staffName: staff?.name,
        slot,
        driveFolderUrl,
      }),
  });

  return notified > 0;
}

async function sendMentorPostSessionTasks(slot, driveFolderUrl, scheduleRevision) {
  const recipients = await resolveMentorRecipients(slot);
  if (!recipients.length) return false;

  const whenText = formatMentorWhen(slot);
  const batchLine =
    Array.isArray(slot.target_batch_ids) && slot.target_batch_ids.length
      ? slot.target_batch_ids.join(", ")
      : "N/A";
  const title = "Mentor session ended — upload recording";
  const message = `Your mentor session has ended (${whenText}). Upload the recording to: ${driveFolderUrl}. Batch: ${batchLine}.`;
  const slotId = String(slot._id);

  let notified = 0;
  for (const recipient of recipients) {
    const dedupeKey = `mentor_post_session_tasks:${slotId}:${scheduleRevision}:${String(recipient._id)}`;
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(recipient._id),
      title,
      message,
      category: "alerts",
      event_type: "mentor_post_session_tasks",
      action_url: MENTOR_SESSION_ACTION,
      dedupe_key: dedupeKey,
    });
    notified += 1;

    const toEmail = String(recipient.email || "").trim();
    if (toEmail) {
      try {
        const mail = buildMentorPostSessionTasksEmail({
          staffName: recipient.name,
          slot,
          driveFolderUrl,
        });
        await sendSimpleEmail({ toEmail, ...mail });
      } catch (e) {
        console.error("[MENTOR_POST_SESSION_TASK_EMAIL_FAILED]", e?.message || e);
      }
    }
  }

  return notified > 0;
}

async function rollbackTimetableTaskClaim(slotId) {
  await TimetableSlot.updateOne(
    { _id: slotId },
    {
      $set: {
        post_class_tasks_sent_schedule_revision: null,
        post_class_tasks_sent_at: null,
      },
    }
  ).catch(() => {});
}

async function rollbackMentorTaskClaim(slotId) {
  await MentorSlot.updateOne(
    { _id: slotId },
    {
      $set: {
        post_session_tasks_sent_schedule_revision: null,
        post_session_tasks_sent_at: null,
      },
    }
  ).catch(() => {});
}

async function processTimetablePostClassTasks(now, cutoffState) {
  const dates = lookbackClassDates(now);
  const candidates = await TimetableSlot.find({
    class_date: { $in: dates },
    $expr: pendingTasksRevisionExpr,
  })
    .select(
      "_id batch_id section_id class_date time subject topic teacher staff_id schedule_revision recording_link post_class_tasks_sent_schedule_revision post_class_destination_alerted_schedule_revision"
    )
    .lean();

  for (const slot of candidates) {
    const endsAt = parseSlotEnd(slot.class_date, slot.time);
    if (!endsAt || endsAt > now) continue;
    if (!isSessionEndEligibleForPostTasks(endsAt, cutoffState)) continue;

    const scheduleRevision = Number(slot.schedule_revision) || 1;
    const destination = await resolveRecordingDestination({ kind: "timetable", slot });

    if (destination.status !== "ok" || !destination.drive_folder_url) {
      await maybeAlertTimetableDestinationIssue(slot, destination, scheduleRevision);
      continue;
    }

    const claimed = await TimetableSlot.updateOne(
      {
        _id: slot._id,
        $expr: pendingTasksRevisionExpr,
      },
      {
        $set: {
          post_class_tasks_sent_schedule_revision: scheduleRevision,
          post_class_tasks_sent_at: new Date(),
        },
      }
    );
    if (claimed.modifiedCount !== 1) continue;

    try {
      const sent = await sendTimetablePostClassTasks(
        slot,
        destination.drive_folder_url,
        scheduleRevision
      );
      if (!sent) {
        console.warn("[TIMETABLE_POST_CLASS_TASKS] No instructor resolved — rolling back claim", {
          slot_id: String(slot._id),
        });
        await rollbackTimetableTaskClaim(slot._id);
      }
    } catch (e) {
      await rollbackTimetableTaskClaim(slot._id);
      console.error("[TIMETABLE_POST_CLASS_TASKS_FAILED]", e?.message || e);
    }
  }
}

async function processMentorPostSessionTasks(now, cutoffState) {
  const lookbackStart = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await MentorSlot.find({
    publish_date: { $lte: now },
    booking_state: { $ne: "cancelled" },
    date: { $gte: lookbackStart },
    $expr: pendingMentorTasksRevisionExpr,
  })
    .select(
      "_id subject mentor_name staff_id date time duration_minutes schedule_revision target_batch_ids target_section_ids target_student_ids publish_date booking_state post_session_tasks_sent_schedule_revision post_session_destination_alerted_schedule_revision"
    )
    .lean();

  for (const slot of candidates) {
    if (!isMentorSlotPublished(slot, now)) continue;

    const endsAt = parseMentorSessionEnd(slot);
    if (!endsAt || endsAt > now) continue;
    if (!isSessionEndEligibleForPostTasks(endsAt, cutoffState)) continue;

    const scheduleRevision = Number(slot.schedule_revision) || 1;
    const destination = await resolveRecordingDestination({ kind: "mentor", slot });

    if (destination.status !== "ok" || !destination.drive_folder_url) {
      await maybeAlertMentorDestinationIssue(slot, destination, scheduleRevision);
      continue;
    }

    const claimed = await MentorSlot.updateOne(
      {
        _id: slot._id,
        $expr: pendingMentorTasksRevisionExpr,
      },
      {
        $set: {
          post_session_tasks_sent_schedule_revision: scheduleRevision,
          post_session_tasks_sent_at: new Date(),
        },
      }
    );
    if (claimed.modifiedCount !== 1) continue;

    try {
      const sent = await sendMentorPostSessionTasks(slot, destination.drive_folder_url, scheduleRevision);
      if (!sent) {
        console.warn("[MENTOR_POST_SESSION_TASKS] No mentor resolved — rolling back claim", {
          slot_id: String(slot._id),
        });
        await rollbackMentorTaskClaim(slot._id);
      }
    } catch (e) {
      await rollbackMentorTaskClaim(slot._id);
      console.error("[MENTOR_POST_SESSION_TASKS_FAILED]", e?.message || e);
    }
  }
}

async function runPostSessionTasksTick() {
  const cutoffState = getPostSessionTasksCutoff();
  if (!cutoffState.enabled) return { enabled: false, reason: cutoffState.reason };

  const now = new Date();
  await processTimetablePostClassTasks(now, cutoffState);
  await processMentorPostSessionTasks(now, cutoffState);
  return { enabled: true };
}

module.exports = {
  runPostSessionTasksTick,
  LOOKBACK_DAYS,
};
