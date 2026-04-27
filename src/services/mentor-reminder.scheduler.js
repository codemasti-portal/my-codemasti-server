const MentorSlot = require("../models/MentorSlot");
const Staff = require("../models/Staff");
const { sendSimpleEmail } = require("./brevo");
const { emitEventNotification } = require("./staffPanelNotification.service");

const CHECK_INTERVAL_MS = 60 * 1000;

function parseSessionStart(dateValue, timeLabel) {
  const base = new Date(dateValue);
  if (Number.isNaN(base.getTime())) return null;
  const raw = String(timeLabel || "").trim();
  const m24 = raw.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!m24) {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  }
  const hh = Number(m24[1]);
  const mm = Number(m24[2]);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
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
  const whenText = startsAt ? startsAt.toLocaleString() : `${new Date(slot.date).toLocaleDateString()} ${slot.time}`;
  const title = "Mentor session starts in 15 minutes";
  const message = `Your mentor session starts in 15 minutes at ${whenText}.`;

  for (const recipient of recipients) {
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(recipient._id),
      title,
      message: `${message} Meet link: ${slot.meet_link || "Not set"}`,
      category: "alerts",
      event_type: "mentor_session_reminder_15m",
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

async function sendMissingMeetLinkAlert(slot) {
  const mentorName = String(slot?.mentor_name || "").trim();
  if (!mentorName) return false;
  const mentorRecipients = await Staff.find({
    role: { $in: ["mentor", "instructor"] },
    is_active: true,
    name: mentorName,
  })
    .select("email name")
    .lean();
  const adminRecipients = await Staff.find({
    role: { $in: ["super_admin", "admin"] },
    is_active: true,
  })
    .select("email name")
    .lean();
  const all = [...mentorRecipients, ...adminRecipients].filter((r) => r.email);
  if (!all.length) return false;

  const startsAt = parseSessionStart(slot.date, slot.time);
  const whenText = startsAt ? startsAt.toLocaleString() : `${new Date(slot.date).toLocaleDateString()} ${slot.time}`;
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
      "_id mentor_name date time meet_link publish_date reminder_15m_sent_at meet_link_missing_alert_15m_sent_at target_batch_ids target_section_ids"
    )
    .lean();

  for (const slot of candidates) {
    const startsAt = parseSessionStart(slot.date, slot.time);
    if (!startsAt) continue;
    if (!(startsAt > now && startsAt <= upper)) continue;
    const missingMeetLink = !String(slot.meet_link || "").trim();
    if (missingMeetLink && !slot.meet_link_missing_alert_15m_sent_at) {
      try {
        const alerted = await sendMissingMeetLinkAlert(slot);
        if (alerted) {
          await MentorSlot.updateOne(
            { _id: slot._id, meet_link_missing_alert_15m_sent_at: null },
            { $set: { meet_link_missing_alert_15m_sent_at: new Date() } }
          );
        }
      } catch (e) {
        console.error("[MENTOR_MISSING_LINK_ALERT_FAILED]", e?.message || e);
      }
      continue;
    }
    try {
      const sent = await sendMentorReminder(slot);
      if (sent) {
        await MentorSlot.updateOne(
          { _id: slot._id, reminder_15m_sent_at: null },
          { $set: { reminder_15m_sent_at: new Date() } }
        );
      }
    } catch (e) {
      console.error("[MENTOR_15M_REMINDER_FAILED]", e?.message || e);
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

module.exports = { startMentorReminderScheduler };
