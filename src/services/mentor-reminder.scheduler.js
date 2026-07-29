const MentorSlot = require("../models/MentorSlot");
const Staff = require("../models/Staff");
const Student = require("../models/Student");
const Notification = require("../models/Notification");
const { sendSimpleEmail } = require("./brevo");
const { emitEventNotification } = require("./staffPanelNotification.service");
const { studentsInBatchesFilterResolved } = require("../utils/student-batch-context");
const {
  parseSlotStart,
  formatDateYmdInClassTimeZone,
  getClassTimeZone,
} = require("../utils/timetable-slot-start");

const CHECK_INTERVAL_MS = 60 * 1000;

function parseSessionStart(dateValue, timeLabel) {
  const dateYmd = formatDateYmdInClassTimeZone(dateValue);
  if (!dateYmd) return null;
  return parseSlotStart(dateYmd, timeLabel);
}

function formatMentorWhen(startsAt, fallbackDate, fallbackTime) {
  if (!startsAt) return `${new Date(fallbackDate).toLocaleDateString()} ${fallbackTime || ""}`.trim();
  const tz = getClassTimeZone();
  return startsAt.toLocaleString(undefined, { timeZone: tz });
}

async function sendMentorReminder(slot) {
  const mentorName = String(slot?.mentor_name || "").trim();
  if (!mentorName) return false;
  const recipients = await Staff.find({
    role: { $in: ["mentor", "instructor"] },
    is_active: true,
    name: mentorName,
  })
    .select("_id name email role")
    .lean();
  if (!recipients.length) return false;

  const startsAt = parseSessionStart(slot.date, slot.time);
  const whenText = formatMentorWhen(startsAt, slot.date, slot.time);
  const title = "Mentor session starts in 15 minutes";
  const message = `Your mentor session starts in 15 minutes at ${whenText}.`;

  const slotId = String(slot._id);
  for (const recipient of recipients) {
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(recipient._id),
      title,
      message: `${message} Meet link: ${slot.meet_link || "Not set"}`,
      category: "alerts",
      event_type: "mentor_session_reminder_15m",
      dedupe_key: `mentor_session_reminder_15m:${slotId}:${String(recipient._id)}`,
    });

    if (recipient.email) {
      const subject = "Reminder: Mentor session starts in 15 minutes";
      const htmlContent = `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Mentor session reminder</h2>
          <p>Hello ${recipient.name || mentorName},</p>
          <p>Your mentor session starts in <strong>15 minutes</strong>.</p>
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
        "Your mentor session starts in 15 minutes.",
        `Start: ${whenText}`,
        `Time label: ${slot.time || "N/A"}`,
        `Meet link: ${slot.meet_link || "Not set"}`,
      ].join("\n");
      await sendSimpleEmail({ toEmail: recipient.email, subject, htmlContent, textContent });
    }
  }

  return true;
}

/** Same target resolution used at publish-time (admin-catalog.controller.js) — individual > batch/section. */
async function resolveMentorSlotStudents(slot) {
  const targetStudentIds = Array.isArray(slot?.target_student_ids)
    ? slot.target_student_ids.map((id) => String(id)).filter(Boolean)
    : [];
  const targetBatchIds = Array.isArray(slot?.target_batch_ids)
    ? slot.target_batch_ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean)
    : [];
  const targetSectionIds = Array.isArray(slot?.target_section_ids)
    ? slot.target_section_ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean)
    : [];

  if (targetStudentIds.length > 0) {
    return Student.find({ _id: { $in: targetStudentIds }, role: "student" }).select("_id name email").lean();
  }
  if (targetBatchIds.length > 0) {
    const filter = await studentsInBatchesFilterResolved(targetBatchIds, {
      sectionIds: targetSectionIds.length > 0 ? targetSectionIds : undefined,
    });
    return Student.find(filter).select("_id name email").lean();
  }
  return [];
}

async function insertNotificationsIgnoringDuplicates(docs) {
  if (!docs.length) return;
  try {
    await Notification.insertMany(docs, { ordered: false });
  } catch (e) {
    const writeErrors = e?.writeErrors || e?.result?.result?.writeErrors;
    const isDupOnly = Array.isArray(writeErrors)
      ? writeErrors.every((we) => (we?.code ?? we?.err?.code) === 11000)
      : e?.code === 11000;
    if (!isDupOnly) throw e;
  }
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
  const mentorName = String(slot?.mentor_name || "").trim();
  if (!mentorName) return false;
  const mentorRecipients = await Staff.find({
    role: { $in: ["mentor", "instructor"] },
    is_active: true,
    name: mentorName,
  })
    .select("_id email name")
    .lean();
  const adminRecipients = await Staff.find({
    role: { $in: ["super_admin", "admin"] },
    is_active: true,
  })
    .select("email name")
    .lean();

  const startsAt = parseSessionStart(slot.date, slot.time);
  const whenText = formatMentorWhen(startsAt, slot.date, slot.time);
  const slotId = String(slot._id);
  const panelTitle = "Meet link missing — mentor session";
  const panelMessage = `Mentor session by ${mentorName} starts in ~15 minutes (${whenText}) but has no meet link.`;

  // Staff panel notification for the mentor themselves.
  for (const r of mentorRecipients) {
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(r._id),
      title: panelTitle,
      message: panelMessage,
      category: "alerts",
      event_type: "mentor_session_meet_missing_15m",
      dedupe_key: `mentor_meet_missing:${slotId}:${String(r._id)}`,
    });
  }
  // Staff panel notification broadcast to admins.
  await emitEventNotification({
    audience: "role",
    target_roles: ["super_admin", "admin"],
    title: panelTitle,
    message: panelMessage,
    category: "alerts",
    event_type: "mentor_session_meet_missing_15m",
    dedupe_key: `mentor_meet_missing:${slotId}:role:admin`,
  });

  const all = [...mentorRecipients, ...adminRecipients].filter((r) => r.email);
  if (!all.length) return true; // panel notifications were sent; email is best-effort

  const subject = "Action required: Meet link missing for upcoming mentor session";
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Meet link missing</h2>
      <p>The following mentor session starts in about 15 minutes, but meet link is still not added:</p>
      <ul>
        <li><strong>Mentor:</strong> ${mentorName}</li>
        <li><strong>Start:</strong> ${whenText}</li>
        <li><strong>Session time:</strong> ${slot.time || "N/A"}</li>
        <li><strong>Batch:</strong> ${(slot.target_batch_ids || []).join(", ") || "N/A"}</li>
        <li><strong>Sections:</strong> ${(slot.target_section_ids || []).join(", ") || "All sections"}</li>
      </ul>
      <p>Please add the meet link as soon as possible.</p>
    </div>
  `.trim();
  const textContent = [
    "Meet link missing for an upcoming mentor session.",
    `Mentor: ${mentorName}`,
    `Start: ${whenText}`,
    `Session time: ${slot.time || "N/A"}`,
    `Batch: ${(slot.target_batch_ids || []).join(", ") || "N/A"}`,
    `Sections: ${(slot.target_section_ids || []).join(", ") || "All sections"}`,
    "Please add the meet link as soon as possible.",
  ].join("\n");

  const uniqueEmails = [...new Set(all.map((r) => String(r.email).trim().toLowerCase()))];
  for (const toEmail of uniqueEmails) {
    await sendSimpleEmail({ toEmail, subject, htmlContent, textContent });
  }
  return true;
}

async function runReminderTick() {
  const now = new Date();
  const upper = new Date(now.getTime() + 15 * 60 * 1000);
  const candidates = await MentorSlot.find({
    publish_date: { $lte: now },
    reminder_15m_sent_at: null,
    date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  })
    .select(
      "_id mentor_name date time meet_link publish_date reminder_15m_sent_at meet_link_missing_alert_15m_sent_at target_batch_ids target_section_ids target_student_ids"
    )
    .lean();

  for (const slot of candidates) {
    const startsAt = parseSessionStart(slot.date, slot.time);
    if (!startsAt) continue;
    if (!(startsAt > now && startsAt <= upper)) continue;
    const missingMeetLink = !String(slot.meet_link || "").trim();

    if (missingMeetLink && !slot.meet_link_missing_alert_15m_sent_at) {
      // Claim first (atomic), then send — so an overlapping/retried cron tick can never
      // double-fire this alert even if two ticks race on the same slot.
      const claimed = await MentorSlot.updateOne(
        { _id: slot._id, meet_link_missing_alert_15m_sent_at: null },
        { $set: { meet_link_missing_alert_15m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const alerted = await sendMissingMeetLinkAlert(slot);
          // No mentor name to resolve recipients from — roll back so a later tick can
          // retry once the slot is fixed, instead of silently skipping it forever.
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

    if (!slot.reminder_15m_sent_at) {
      const claimed = await MentorSlot.updateOne(
        { _id: slot._id, reminder_15m_sent_at: null },
        { $set: { reminder_15m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const sent = await sendMentorReminder(slot);
          if (!sent) {
            await MentorSlot.updateOne({ _id: slot._id }, { $set: { reminder_15m_sent_at: null } });
          }
        } catch (e) {
          await MentorSlot.updateOne({ _id: slot._id }, { $set: { reminder_15m_sent_at: null } }).catch(() => {});
          console.error("[MENTOR_15M_REMINDER_FAILED]", e?.message || e);
        }
        // Best-effort: a failure here shouldn't roll back the mentor's reminder above (already
        // sent/deduped) — dedupe_key makes this safe to simply retry-log rather than reclaim.
        try {
          await sendStudentMentorReminder(slot, formatMentorWhen(startsAt, slot.date, slot.time));
        } catch (e) {
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
