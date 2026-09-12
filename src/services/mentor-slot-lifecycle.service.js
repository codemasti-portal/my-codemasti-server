const mongoose = require("mongoose");
const Staff = require("../models/Staff");
const { parseGoogleMeetUrl } = require("../utils/google-meet-url");
const {
  parseSlotStart,
  formatDateYmdInClassTimeZone,
  getClassTimeZone,
} = require("../utils/timetable-slot-start");
const { resolveMentorRecipients } = require("./mentor-notification.service");
const { emitEventNotification } = require("./staffPanelNotification.service");
const { sendSimpleEmail } = require("./brevo");

/** Mentor sessions starting within this window skip the separate 60-minute cron reminder. */
const MENTOR_60M_SUPPRESS_WITHIN_MINUTES = 60;

const MENTOR_SESSION_ACTION = "/dashboard/mentor/sessions";

function parseMentorSessionStart(slot) {
  const dateYmd = formatDateYmdInClassTimeZone(slot?.date);
  if (!dateYmd) return null;
  return parseSlotStart(dateYmd, slot?.time);
}

/** Scheduled session end = start + duration_minutes (existing mentor semantics). */
function parseMentorSessionEnd(slot) {
  const startsAt = parseMentorSessionStart(slot);
  if (!startsAt) return null;
  const durationMinutes = Number(slot?.duration_minutes) || 60;
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) return null;
  return new Date(startsAt.getTime() + durationMinutes * 60_000);
}

function formatMentorWhen(slot) {
  const startsAt = parseMentorSessionStart(slot);
  if (!startsAt) {
    return `${new Date(slot?.date).toLocaleDateString()} ${slot?.time || ""}`.trim();
  }
  const tz = getClassTimeZone();
  return startsAt.toLocaleString(undefined, { timeZone: tz });
}

function minutesUntilMentorSessionStart(slot, at = new Date()) {
  const startsAt = parseMentorSessionStart(slot);
  if (!startsAt) return null;
  return Math.round((startsAt.getTime() - at.getTime()) / 60_000);
}

function isMentorSlotPublished(slot, at = new Date()) {
  if (String(slot?.booking_state || "") === "cancelled") return false;
  const pubAt = slot?.publish_date ? new Date(slot.publish_date).getTime() : at.getTime();
  return pubAt <= at.getTime();
}

function mentorIdentityChanged(prevStaffId, prevName, nextStaffId, nextName) {
  const prevId = String(prevStaffId || "").trim();
  const nextId = String(nextStaffId || "").trim();
  if (prevId && nextId) return prevId !== nextId;
  if (prevId !== nextId) return true;
  return String(prevName || "").trim().toLowerCase() !== String(nextName || "").trim().toLowerCase();
}

function canonicalMeetLink(value) {
  return parseGoogleMeetUrl(value) || String(value || "").trim();
}

function meetLinkChanged(prevLink, nextLink) {
  const prev = canonicalMeetLink(prevLink);
  const next = canonicalMeetLink(nextLink);
  return Boolean(next) && prev !== next;
}

function mentorScheduleChanged(prevDate, prevTime, nextDate, nextTime) {
  const prevMs = prevDate ? new Date(prevDate).getTime() : 0;
  const nextMs = nextDate ? new Date(nextDate).getTime() : 0;
  return prevMs !== nextMs || String(prevTime || "").trim() !== String(nextTime || "").trim();
}

function shouldSuppressMentor60mReminder(slot, at = new Date()) {
  const mins = minutesUntilMentorSessionStart(slot, at);
  if (mins === null) return false;
  return mins <= MENTOR_60M_SUPPRESS_WITHIN_MINUTES;
}

function is60mReminderSuppressedForCurrentSchedule(slot) {
  const rev = Number(slot.schedule_revision) || 1;
  const suppressed = slot.mentor_reminder_60m_suppressed_schedule_revision;
  return suppressed != null && Number(suppressed) === rev;
}

/**
 * Mentor 60m cron eligibility. `reminder_15m_sent_at` is student-only after Phase 2 split.
 * Legacy: pre-split rows may have `reminder_15m_sent_at` from the old combined mentor+student
 * tick — treat that as mentor-satisfied only while the original assignment is still current
 * (mentor_assignment_revision === 1), so a reassigned mentor is not blocked by student timing.
 */
function isMentor60mReminderAlreadySatisfied(slot) {
  if (slot.reminder_60m_sent_at) return true;
  if (
    slot.reminder_15m_sent_at &&
    (Number(slot.mentor_assignment_revision) || 1) === 1
  ) {
    return true;
  }
  return false;
}

function apply60mSuppressionForCurrentSchedule(doc) {
  const rev = Number(doc.schedule_revision) || 1;
  if (shouldSuppressMentor60mReminder(doc)) {
    doc.mentor_reminder_60m_suppressed_schedule_revision = rev;
  } else {
    doc.mentor_reminder_60m_suppressed_schedule_revision = null;
  }
}

/** Schedule change: session timing changed — reset both mentor 60m and student 15m markers. */
function resetMentorScheduleReminderMarkers(doc) {
  doc.reminder_15m_sent_at = null;
  doc.reminder_60m_sent_at = null;
}

/** Mentor-only reassignment: reset mentor 60m only; student 15m timing is unchanged. */
function resetMentorOnlyReminderMarkers(doc) {
  doc.reminder_60m_sent_at = null;
}

function initLifecycleFieldsOnCreate(doc) {
  doc.schedule_revision = 1;
  doc.mentor_assignment_revision = 1;
  doc.meet_link_revision = 1;
  apply60mSuppressionForCurrentSchedule(doc);
}

function audienceSummary(slot) {
  const batchLine =
    Array.isArray(slot.target_batch_ids) && slot.target_batch_ids.length
      ? slot.target_batch_ids.join(", ")
      : "N/A";
  const sectionLine =
    Array.isArray(slot.target_section_ids) && slot.target_section_ids.length
      ? slot.target_section_ids.join(", ")
      : "All sections";
  const audienceLine =
    Array.isArray(slot.target_student_ids) && slot.target_student_ids.length
      ? `${slot.target_student_ids.length} selected student(s)`
      : "All students in selected batch/sections";
  return { batchLine, sectionLine, audienceLine };
}

function buildMentorPostSessionTasksEmail({ staffName, slot, driveFolderUrl }) {
  const whenText = formatMentorWhen(slot);
  const { batchLine, sectionLine } = audienceSummary(slot);
  const subject = `Upload mentor session recording (${whenText})`;
  const sessionsUrl = String(process.env.ADMIN_PORTAL_URL || "").trim().replace(/\/$/, "");
  const sessionsPath = "/dashboard/mentor/sessions";
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Mentor session ended — upload recording</h2>
      <p>Hello ${staffName || "Mentor"},</p>
      <p>Your mentor session has ended. Please upload the session recording to the batch Google Drive folder below.</p>
      <ul>
        <li><strong>Session:</strong> ${slot.subject || "Mentor Session"}</li>
        <li><strong>When:</strong> ${whenText}</li>
        <li><strong>Batch:</strong> ${batchLine}</li>
        <li><strong>Sections:</strong> ${sectionLine}</li>
      </ul>
      <p><strong>Upload to:</strong> <a href="${driveFolderUrl}">${driveFolderUrl}</a></p>
      ${sessionsUrl ? `<p><a href="${sessionsUrl}${sessionsPath}">Open mentor sessions in CodeMasti</a></p>` : ""}
    </div>
  `.trim();
  const textContent = [
    `Hello ${staffName || "Mentor"},`,
    "Your mentor session has ended. Please upload the session recording to the batch Google Drive folder.",
    `Session: ${slot.subject || "Mentor Session"}`,
    `When: ${whenText}`,
    `Batch: ${batchLine}`,
    `Sections: ${sectionLine}`,
    `Upload to: ${driveFolderUrl}`,
    sessionsUrl ? `Portal: ${sessionsUrl}${sessionsPath}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { subject, htmlContent, textContent };
}

function buildMentorAssignedEmail({ staffName, slot }) {
  const whenText = formatMentorWhen(slot);
  const { batchLine, sectionLine, audienceLine } = audienceSummary(slot);
  const meet = String(slot.meet_link || "").trim();
  const subject = `Mentor session assigned (${whenText})`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Mentor session assigned</h2>
      <p>Hello ${staffName || "Mentor"},</p>
      <p>You have been assigned to a mentor session with the following details:</p>
      <ul>
        <li><strong>When:</strong> ${whenText}</li>
        <li><strong>Time label:</strong> ${slot.time || "N/A"}</li>
        <li><strong>Batch:</strong> ${batchLine}</li>
        <li><strong>Sections:</strong> ${sectionLine}</li>
        <li><strong>Audience:</strong> ${audienceLine}</li>
        <li><strong>Meet link:</strong> ${meet || "Not set"}</li>
      </ul>
    </div>
  `.trim();
  const textContent = [
    `Hello ${staffName || "Mentor"},`,
    "You have been assigned to a mentor session.",
    `When: ${whenText}`,
    `Time label: ${slot.time || "N/A"}`,
    `Batch: ${batchLine}`,
    `Sections: ${sectionLine}`,
    `Audience: ${audienceLine}`,
    `Meet link: ${meet || "Not set"}`,
  ].join("\n");
  return { subject, htmlContent, textContent };
}

function buildMentorRescheduledEmail({ staffName, slot, previousSchedule }) {
  const whenText = formatMentorWhen(slot);
  const prevWhen =
    previousSchedule?.date && previousSchedule?.time
      ? formatMentorWhen({ date: previousSchedule.date, time: previousSchedule.time })
      : "";
  const { batchLine, sectionLine } = audienceSummary(slot);
  const meet = String(slot.meet_link || "").trim();
  const subject = `Mentor session rescheduled (${whenText})`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Mentor session rescheduled</h2>
      <p>Hello ${staffName || "Mentor"},</p>
      <p>Your mentor session schedule has changed.</p>
      <ul>
        ${prevWhen ? `<li><strong>Previous:</strong> ${prevWhen}</li>` : ""}
        <li><strong>New time:</strong> ${whenText}</li>
        <li><strong>Batch:</strong> ${batchLine}</li>
        <li><strong>Sections:</strong> ${sectionLine}</li>
        <li><strong>Meet link:</strong> ${meet || "Not set"}</li>
      </ul>
    </div>
  `.trim();
  const textContent = [
    `Hello ${staffName || "Mentor"},`,
    "Your mentor session schedule has changed.",
    prevWhen ? `Previous: ${prevWhen}` : null,
    `New time: ${whenText}`,
    `Meet link: ${meet || "Not set"}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { subject, htmlContent, textContent };
}

function buildMentorUnassignedEmail({ staffName, slot }) {
  const whenText = formatMentorWhen(slot);
  const subject = `Mentor session unassigned (${whenText})`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Mentor session unassigned</h2>
      <p>Hello ${staffName || "Mentor"},</p>
      <p>You are no longer assigned to the mentor session on <strong>${whenText}</strong>.</p>
    </div>
  `.trim();
  const textContent = [
    `Hello ${staffName || "Mentor"},`,
    `You are no longer assigned to the mentor session on ${whenText}.`,
  ].join("\n");
  return { subject, htmlContent, textContent };
}

function buildMentorMeetLinkUpdatedEmail({ staffName, slot }) {
  const whenText = formatMentorWhen(slot);
  const meet = String(slot.meet_link || "").trim();
  const subject = `Meet link updated for mentor session (${whenText})`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Meet link updated</h2>
      <p>Hello ${staffName || "Mentor"},</p>
      <p>The Meet link for your mentor session on <strong>${whenText}</strong> has been updated.</p>
      <p><strong>New Meet link:</strong> ${meet || "Not set"}</p>
    </div>
  `.trim();
  const textContent = [
    `Hello ${staffName || "Mentor"},`,
    `The Meet link for your mentor session on ${whenText} has been updated.`,
    `New Meet link: ${meet || "Not set"}`,
  ].join("\n");
  return { subject, htmlContent, textContent };
}

async function notifyMentorRecipients({
  slot,
  event_type,
  title,
  message,
  action_url,
  dedupe_key,
  emailBuilder,
}) {
  const recipients = await resolveMentorRecipients(slot);
  if (!recipients.length) return { notified: 0, emailed: 0 };

  let notified = 0;
  let emailed = 0;
  const slotId = String(slot._id || "");
  for (const r of recipients) {
    const dedupeKey = dedupe_key
      ? `${String(dedupe_key).trim()}:${String(r._id)}`
      : `${String(event_type || "event").trim()}:${slotId}:${String(r._id)}`;
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(r._id),
      title,
      message,
      category: "alerts",
      event_type,
      action_url: action_url || MENTOR_SESSION_ACTION,
      dedupe_key: dedupeKey,
    });
    notified += 1;

    const toEmail = String(r.email || "").trim();
    if (emailBuilder && toEmail) {
      try {
        const mail = emailBuilder({ staff: r, slot });
        await sendSimpleEmail({ toEmail, ...mail });
        emailed += 1;
      } catch (e) {
        console.error("[MENTOR_LIFECYCLE_EMAIL_FAILED]", event_type, e?.message || e);
      }
    }
  }
  return { notified, emailed };
}

async function notifySpecificMentorStaff({
  staffId,
  slot,
  event_type,
  title,
  message,
  action_url,
  dedupe_key,
  emailBuilder,
}) {
  let id = String(staffId || "").trim();
  if (!id || !mongoose.isValidObjectId(id)) {
    const matches = await resolveMentorRecipients({ ...slot, staff_id: null });
    if (matches.length !== 1) return { notified: 0, emailed: 0 };
    id = String(matches[0]._id);
  }

  const row = await Staff.findOne({ _id: id }).select("_id name email role").lean();
  if (!row) return { notified: 0, emailed: 0 };

  const dedupeKey =
    dedupe_key ||
    `${String(event_type || "event").trim()}:${String(slot?._id || "").trim()}:${String(row._id)}`;

  await emitEventNotification({
    audience: "individual",
    recipient_id: String(row._id),
    title,
    message,
    category: "alerts",
    event_type,
    action_url: action_url || MENTOR_SESSION_ACTION,
    dedupe_key: dedupeKey,
  });

  let emailed = 0;
  const toEmail = String(row.email || "").trim();
  if (emailBuilder && toEmail) {
    try {
      const mail = emailBuilder({ staff: row, slot });
      await sendSimpleEmail({ toEmail, ...mail });
      emailed = 1;
    } catch (e) {
      console.error("[MENTOR_LIFECYCLE_EMAIL_FAILED]", event_type, e?.message || e);
    }
  }
  return { notified: 1, emailed };
}

async function notifyMentorAssigned(slot, assignmentRevision) {
  const rev = Number(assignmentRevision) || 1;
  const whenText = formatMentorWhen(slot);
  const meet = String(slot.meet_link || "").trim();
  const staffKey = String(slot.staff_id || slot.mentor_name || "").trim();
  try {
    await notifyMentorRecipients({
      slot,
      event_type: "mentor_session_assigned",
      title: "Mentor session assigned",
      message: `You have been assigned to a mentor session on ${whenText}.${meet ? ` Meet: ${meet}` : ""}`,
      action_url: MENTOR_SESSION_ACTION,
      dedupe_key: `mentor_session_assigned:${String(slot._id)}:${staffKey}:${rev}`,
      emailBuilder: ({ staff }) => buildMentorAssignedEmail({ staffName: staff?.name, slot }),
    });
  } catch (e) {
    console.error("[MENTOR_SESSION_ASSIGNED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function notifyMentorUnassigned(prevSlot, prevStaffId, assignmentRevision) {
  const rev = Number(assignmentRevision) || 1;
  const staffKey = String(prevStaffId || prevSlot.mentor_name || "").trim();
  if (!staffKey) return;
  const whenText = formatMentorWhen(prevSlot);
  try {
    await notifySpecificMentorStaff({
      staffId: prevStaffId,
      slot: prevSlot,
      event_type: "mentor_session_unassigned",
      title: "Mentor session unassigned",
      message: `You are no longer assigned to the mentor session on ${whenText}.`,
      action_url: MENTOR_SESSION_ACTION,
      dedupe_key: `mentor_session_unassigned:${String(prevSlot._id)}:${staffKey}:${rev}`,
      emailBuilder: ({ staff }) => buildMentorUnassignedEmail({ staffName: staff?.name, slot: prevSlot }),
    });
  } catch (e) {
    console.error("[MENTOR_SESSION_UNASSIGNED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function notifyMentorRescheduled(slot, scheduleRevision, previousSchedule) {
  const rev = Number(scheduleRevision) || 1;
  const whenText = formatMentorWhen(slot);
  const prevWhen =
    previousSchedule?.date && previousSchedule?.time
      ? formatMentorWhen({ date: previousSchedule.date, time: previousSchedule.time })
      : "";
  try {
    await notifyMentorRecipients({
      slot,
      event_type: "mentor_session_rescheduled",
      title: "Mentor session rescheduled",
      message: prevWhen
        ? `Your mentor session moved from ${prevWhen} to ${whenText}.`
        : `Your mentor session was rescheduled to ${whenText}.`,
      action_url: MENTOR_SESSION_ACTION,
      dedupe_key: `mentor_session_rescheduled:${String(slot._id)}:${rev}`,
      emailBuilder: ({ staff }) =>
        buildMentorRescheduledEmail({ staffName: staff?.name, slot, previousSchedule }),
    });
  } catch (e) {
    console.error("[MENTOR_SESSION_RESCHEDULED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function notifyMentorMeetLinkUpdated(slot, meetLinkRevision) {
  const rev = Number(meetLinkRevision) || 1;
  const whenText = formatMentorWhen(slot);
  const meet = String(slot.meet_link || "").trim();
  const startsAt = parseMentorSessionStart(slot);
  if (!startsAt || startsAt.getTime() <= Date.now()) return;

  try {
    await notifyMentorRecipients({
      slot,
      event_type: "mentor_session_meet_link_updated",
      title: "Meet link updated",
      message: `The Meet link for your mentor session on ${whenText} was updated. New link: ${meet}`,
      action_url: MENTOR_SESSION_ACTION,
      dedupe_key: `mentor_session_meet_link_updated:${String(slot._id)}:${rev}`,
      emailBuilder: ({ staff }) => buildMentorMeetLinkUpdatedEmail({ staffName: staff?.name, slot }),
    });
  } catch (e) {
    console.error("[MENTOR_MEET_LINK_UPDATED_NOTIFY_FAILED]", e?.message || e);
  }
}

async function handleMentorLifecycleOnPublish(slot) {
  if (!slot || !isMentorSlotPublished(slot)) return;
  await notifyMentorAssigned(slot, slot.mentor_assignment_revision || 1);
}

async function handleMentorLifecycleAfterUpdate({
  slot,
  becamePublished,
  becameCancelled,
  scheduleChanged,
  mentorChanged,
  meetLinkChanged: meetChanged,
  previousSchedule,
  previousMentor,
}) {
  const slotObj = slot?.toObject ? slot.toObject() : slot;
  if (!slotObj?._id) return;

  if (becameCancelled) return;

  if (!isMentorSlotPublished(slotObj)) return;

  if (becamePublished) {
    await notifyMentorAssigned(slotObj, slotObj.mentor_assignment_revision || 1);
    return;
  }

  if (mentorChanged) {
    const assignmentRev = Number(slotObj.mentor_assignment_revision) || 1;
    const prevSlot = {
      ...slotObj,
      date: previousSchedule?.date ?? slotObj.date,
      time: previousSchedule?.time ?? slotObj.time,
      staff_id: previousMentor?.staff_id ?? null,
      mentor_name: previousMentor?.mentor_name ?? "",
    };
    if (previousMentor?.staff_id || previousMentor?.mentor_name) {
      await notifyMentorUnassigned(prevSlot, previousMentor.staff_id, assignmentRev);
    }
    await notifyMentorAssigned(slotObj, assignmentRev);
    return;
  }

  if (scheduleChanged) {
    await notifyMentorRescheduled(slotObj, slotObj.schedule_revision, previousSchedule);
    return;
  }

  if (meetChanged) {
    await notifyMentorMeetLinkUpdated(slotObj, slotObj.meet_link_revision);
  }
}

module.exports = {
  MENTOR_60M_SUPPRESS_WITHIN_MINUTES,
  MENTOR_SESSION_ACTION,
  parseMentorSessionStart,
  parseMentorSessionEnd,
  formatMentorWhen,
  buildMentorPostSessionTasksEmail,
  minutesUntilMentorSessionStart,
  isMentorSlotPublished,
  mentorIdentityChanged,
  meetLinkChanged,
  mentorScheduleChanged,
  shouldSuppressMentor60mReminder,
  is60mReminderSuppressedForCurrentSchedule,
  isMentor60mReminderAlreadySatisfied,
  apply60mSuppressionForCurrentSchedule,
  resetMentorScheduleReminderMarkers,
  resetMentorOnlyReminderMarkers,
  initLifecycleFieldsOnCreate,
  handleMentorLifecycleOnPublish,
  handleMentorLifecycleAfterUpdate,
  notifyMentorAssigned,
};
