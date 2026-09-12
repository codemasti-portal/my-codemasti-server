const MentorSlot = require("../models/MentorSlot");
const { sendSimpleEmail } = require("./brevo");
const { emitEventNotification } = require("./staffPanelNotification.service");
const { notifySchedulingAlertRecipients } = require("./scheduling-alert-recipients.service");
const {
  resolveMentorRecipients,
  resolveMentorSlotStudents,
  insertNotificationsIgnoringDuplicates,
} = require("./mentor-notification.service");
const {
  parseMentorSessionStart,
  formatMentorWhen,
  is60mReminderSuppressedForCurrentSchedule,
  isMentor60mReminderAlreadySatisfied,
} = require("./mentor-slot-lifecycle.service");

const CHECK_INTERVAL_MS = 60 * 1000;

async function sendMentor60mReminder(slot) {
  const recipients = await resolveMentorRecipients(slot);
  if (!recipients.length) return false;

  const mentorName = String(slot?.mentor_name || "").trim();
  const whenText = formatMentorWhen(slot);
  const title = "Mentor session starts in 1 hour";
  const message = `Your mentor session starts in about 1 hour at ${whenText}.`;

  const slotId = String(slot._id);
  for (const recipient of recipients) {
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(recipient._id),
      title,
      message: `${message} Meet link: ${slot.meet_link || "Not set"}`,
      category: "alerts",
      event_type: "mentor_session_reminder_60m",
      action_url: "/dashboard/mentor/sessions",
      dedupe_key: `mentor_session_reminder_60m:${slotId}:${String(recipient._id)}`,
    });

    if (recipient.email) {
      const subject = "Reminder: mentor session starts in 1 hour";
      const htmlContent = `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Mentor session reminder</h2>
          <p>Hello ${recipient.name || mentorName},</p>
          <p>Your mentor session starts in <strong>about 1 hour</strong>.</p>
          <ul>
            <li><strong>Start:</strong> ${whenText}</li>
            <li><strong>Time label:</strong> ${slot.time || "N/A"}</li>
            <li><strong>Meet link:</strong> ${slot.meet_link || "Not set"}</li>
          </ul>
          <p>Please be ready before session time.</p>
        </div>
      `.trim();
      const textContent = [
        `Hello ${recipient.name || mentorName},`,
        "Your mentor session starts in about 1 hour.",
        `Start: ${whenText}`,
        `Time label: ${slot.time || "N/A"}`,
        `Meet link: ${slot.meet_link || "Not set"}`,
      ].join("\n");
      await sendSimpleEmail({ toEmail: recipient.email, subject, htmlContent, textContent });
    }
  }

  return true;
}

/**
 * Students were previously only ever told once, at publish time, that a mentor session exists —
 * no reminder as it approaches (unlike regular classes, which get a 10-min "starts soon" ping).
 * Mirrors that behavior for mentor sessions at the same 15-minute mark the mentor is reminded.
 */
async function sendStudentMentorReminder(slot, whenText) {
  const students = await resolveMentorSlotStudents(slot);
  if (!students.length) return;

  const slotId = String(slot._id);
  const meet = String(slot.meet_link || "").trim();
  const title = "Mentor session starts in 15 minutes";
  const body = `Your mentor session with ${slot.mentor_name} starts in 15 minutes (${whenText}).`;
  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: `mentor-slot:${slotId}`,
    meet_url: meet,
    dedupe_key: `mentorSessionReminder15m:${slotId}:${String(s._id)}`,
  }));
  await insertNotificationsIgnoringDuplicates(docs);

  if (!meet) return;
  for (const s of students) {
    const toEmail = String(s.email || "").trim();
    if (!toEmail) continue;
    try {
      const subject = "Reminder: your mentor session starts in 15 minutes";
      const htmlContent = `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Mentor session reminder</h2>
          <p>Hello ${s.name || "Student"},</p>
          <p>Your mentor session with <strong>${slot.mentor_name}</strong> starts in <strong>15 minutes</strong>.</p>
          <ul>
            <li><strong>Start:</strong> ${whenText}</li>
            <li><strong>Meet link:</strong> ${meet}</li>
          </ul>
        </div>
      `.trim();
      const textContent = [
        `Hello ${s.name || "Student"},`,
        `Your mentor session with ${slot.mentor_name} starts in 15 minutes.`,
        `Start: ${whenText}`,
        `Meet link: ${meet}`,
      ].join("\n");
      await sendSimpleEmail({ toEmail, subject, htmlContent, textContent });
    } catch (e) {
      console.error("[STUDENT_MENTOR_REMINDER_EMAIL_FAILED]", e?.message || e);
    }
  }
}

async function sendMissingMeetLinkAlert(slot) {
  const mentorName = String(slot?.mentor_name || "").trim() || "N/A";
  const whenText = formatMentorWhen(slot);
  const slotId = String(slot._id);
  const batchLine = (slot.target_batch_ids || []).join(", ") || "N/A";
  const sectionLine = (slot.target_section_ids || []).join(", ") || "All sections";
  const panelTitle = "Meet link missing — mentor session";
  const panelMessage = `Mentor session by ${mentorName} starts in ~15 minutes (${whenText}) but has no Meet link. Batch: ${batchLine}. Sections: ${sectionLine}. Please add the Meet link in mentor slots.`;

  const result = await notifySchedulingAlertRecipients({
    event_type: "mentor_session_meet_missing_15m",
    dedupeKeyPrefix: `mentor_meet_missing:${slotId}`,
    title: panelTitle,
    panelMessage,
    action_url: "/mentor-slots",
    email: (recipient) => ({
      subject: "Action required: Meet link missing for upcoming mentor session",
      htmlContent: `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Meet link missing</h2>
          <p>Hello ${recipient.name || "Scheduling team"},</p>
          <p>The following mentor session starts in about <strong>15 minutes</strong>, but the Google Meet link is still missing:</p>
          <ul>
            <li><strong>Mentor:</strong> ${mentorName}</li>
            <li><strong>Start:</strong> ${whenText}</li>
            <li><strong>Session time:</strong> ${slot.time || "N/A"}</li>
            <li><strong>Batch:</strong> ${batchLine}</li>
            <li><strong>Sections:</strong> ${sectionLine}</li>
          </ul>
          <p>Please add the Meet link in mentor slots.</p>
        </div>
      `.trim(),
      textContent: [
        "Meet link missing for an upcoming mentor session.",
        `Mentor: ${mentorName}`,
        `Start: ${whenText}`,
        `Session time: ${slot.time || "N/A"}`,
        `Batch: ${batchLine}`,
        `Sections: ${sectionLine}`,
        "Please add the Meet link in mentor slots.",
      ].join("\n"),
    }),
  });

  return result.ok;
}

async function runReminderTick() {
  const now = new Date();
  const fifteenMin = new Date(now.getTime() + 15 * 60 * 1000);
  const sixtyMin = new Date(now.getTime() + 60 * 60 * 1000);
  const candidates = await MentorSlot.find({
    publish_date: { $lte: now },
    booking_state: { $ne: "cancelled" },
    date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    $or: [
      { meet_link_missing_alert_15m_sent_at: null },
      { reminder_15m_sent_at: null },
      { reminder_60m_sent_at: null },
    ],
  })
    .select(
      "_id mentor_name staff_id date time meet_link publish_date reminder_15m_sent_at reminder_60m_sent_at meet_link_missing_alert_15m_sent_at mentor_reminder_60m_suppressed_schedule_revision schedule_revision target_batch_ids target_section_ids target_student_ids"
    )
    .lean();

  for (const slot of candidates) {
    const startsAt = parseMentorSessionStart(slot);
    if (!startsAt) continue;

    const whenText = formatMentorWhen(slot);
    const meetAvailable = Boolean(String(slot.meet_link || "").trim());
    const in15mWindow = startsAt > now && startsAt <= fifteenMin;
    const in60mWindow = startsAt > now && startsAt <= sixtyMin;

    // Missing Meet (~15m) — scheduling admins only; timing unchanged in this phase.
    if (!meetAvailable && in15mWindow && !slot.meet_link_missing_alert_15m_sent_at) {
      const claimed = await MentorSlot.updateOne(
        { _id: slot._id, meet_link_missing_alert_15m_sent_at: null },
        { $set: { meet_link_missing_alert_15m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const alerted = await sendMissingMeetLinkAlert(slot);
          if (!alerted) {
            await MentorSlot.updateOne(
              { _id: slot._id },
              { $set: { meet_link_missing_alert_15m_sent_at: null } }
            );
          }
        } catch (e) {
          await MentorSlot.updateOne(
            { _id: slot._id },
            { $set: { meet_link_missing_alert_15m_sent_at: null } }
          ).catch(() => {});
          console.error("[MENTOR_MISSING_LINK_ALERT_FAILED]", e?.message || e);
        }
      }
      continue;
    }

    // Mentor ~60m reminder (panel + Brevo) — separate from student 15m timing.
    if (
      in60mWindow &&
      !slot.reminder_60m_sent_at &&
      !is60mReminderSuppressedForCurrentSchedule(slot) &&
      !isMentor60mReminderAlreadySatisfied(slot)
    ) {
      const claimed = await MentorSlot.updateOne(
        { _id: slot._id, reminder_60m_sent_at: null },
        { $set: { reminder_60m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const sent = await sendMentor60mReminder(slot);
          if (!sent) {
            await MentorSlot.updateOne({ _id: slot._id }, { $set: { reminder_60m_sent_at: null } });
          }
        } catch (e) {
          await MentorSlot.updateOne({ _id: slot._id }, { $set: { reminder_60m_sent_at: null } }).catch(
            () => {}
          );
          console.error("[MENTOR_60M_REMINDER_FAILED]", e?.message || e);
        }
      }
    }

    // Student ~15m reminder — unchanged timing; uses reminder_15m_sent_at only.
    if (meetAvailable && in15mWindow && !slot.reminder_15m_sent_at) {
      const claimed = await MentorSlot.updateOne(
        { _id: slot._id, reminder_15m_sent_at: null },
        { $set: { reminder_15m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          await sendStudentMentorReminder(slot, whenText);
        } catch (e) {
          await MentorSlot.updateOne({ _id: slot._id }, { $set: { reminder_15m_sent_at: null } }).catch(
            () => {}
          );
          console.error("[STUDENT_MENTOR_REMINDER_FAILED]", e?.message || e);
        }
      }
    }
  }
}

function startMentorReminderScheduler() {
  const timer = setInterval(() => {
    runReminderTick().catch((e) => {
      console.error("[MENTOR_REMINDER_TICK_FAILED]", e?.message || e);
    });
  }, CHECK_INTERVAL_MS);
  runReminderTick().catch((e) => {
    console.error("[MENTOR_REMINDER_BOOT_FAILED]", e?.message || e);
  });
  return timer;
}

module.exports = { startMentorReminderScheduler, runReminderTick };
