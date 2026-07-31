const TimetableEvent = require("../models/TimetableEvent");
const Student = require("../models/Student");
const { sendSimpleEmail } = require("./brevo");
const { insertNotificationsIgnoringDuplicates } = require("./mentor-notification.service");
const { studentsInBatchesFilterResolved } = require("../utils/student-batch-context");
const {
  parseSlotStart,
  formatDateYmdInClassTimeZone,
  getClassTimeZone,
} = require("../utils/timetable-slot-start");

const CHECK_INTERVAL_MS = 60 * 1000;

function parseEventStart(event) {
  if (!event || event.all_day !== false) return null;
  const dateYmd = formatDateYmdInClassTimeZone(event.date);
  if (!dateYmd) return null;
  return parseSlotStart(dateYmd, event.time);
}

function formatEventWhen(startsAt, fallbackDate, fallbackTime) {
  if (!startsAt) return `${new Date(fallbackDate).toLocaleDateString()} ${fallbackTime || ""}`.trim();
  const tz = getClassTimeZone();
  return startsAt.toLocaleString(undefined, { timeZone: tz });
}

async function resolveEventStudents(event) {
  const batchId = String(event?.batch_id || "").trim().toLowerCase();
  if (!batchId) return [];
  const sectionId = String(event?.section_id || "").trim().toLowerCase();
  const filter = await studentsInBatchesFilterResolved([batchId], {
    sectionId: sectionId || undefined,
  });
  return Student.find(filter).select("_id name email").lean();
}

async function sendStudentEventReminder(event, whenText) {
  const students = await resolveEventStudents(event);
  if (!students.length) return false;

  const eventId = String(event._id);
  const meet = String(event.meet_link || "").trim();
  const title = "Event starts in 15 minutes";
  const body = `${event.title} starts in 15 minutes (${whenText}).`;
  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: `timetable-event:${eventId}`,
    deep_link: "/timetable",
    meet_url: meet,
    dedupe_key: `timetableEventReminder15m:${eventId}:${String(s._id)}`,
  }));
  await insertNotificationsIgnoringDuplicates(docs);

  if (!meet) return true;
  for (const s of students) {
    const toEmail = String(s.email || "").trim();
    if (!toEmail) continue;
    try {
      const subject = `Reminder: ${event.title} starts in 15 minutes`;
      const htmlContent = `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2 style="margin:0 0 12px">Event reminder</h2>
          <p>Hello ${s.name || "Student"},</p>
          <p><strong>${event.title}</strong> starts in <strong>15 minutes</strong>.</p>
          <ul>
            <li><strong>When:</strong> ${whenText}</li>
            <li><strong>Meet link:</strong> <a href="${meet}">${meet}</a></li>
          </ul>
        </div>
      `.trim();
      const textContent = [
        `Hello ${s.name || "Student"},`,
        `${event.title} starts in 15 minutes.`,
        `When: ${whenText}`,
        `Meet link: ${meet}`,
      ].join("\n");
      await sendSimpleEmail({ toEmail, subject, htmlContent, textContent });
    } catch (e) {
      console.error("[STUDENT_EVENT_REMINDER_EMAIL_FAILED]", e?.message || e);
    }
  }
  return true;
}

/**
 * 15-minute reminder for timed TimetableEvents that have a Meet link.
 * Holidays / all-day events are never reminded.
 */
async function runEventReminderTick() {
  const now = new Date();
  const upper = new Date(now.getTime() + 15 * 60 * 1000);
  const candidates = await TimetableEvent.find({
    all_day: false,
    reminder_15m_sent_at: null,
    meet_link: { $exists: true, $nin: ["", null] },
    type: { $ne: "holiday" },
    date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  })
    .select("_id title type date time meet_link batch_id section_id all_day reminder_15m_sent_at")
    .lean();

  for (const event of candidates) {
    const meet = String(event.meet_link || "").trim();
    if (!meet) continue;
    const startsAt = parseEventStart(event);
    if (!startsAt) continue;
    if (!(startsAt > now && startsAt <= upper)) continue;

    const claimed = await TimetableEvent.updateOne(
      { _id: event._id, reminder_15m_sent_at: null },
      { $set: { reminder_15m_sent_at: new Date() } }
    );
    if (claimed.modifiedCount !== 1) continue;

    try {
      const whenText = formatEventWhen(startsAt, event.date, event.time);
      const sent = await sendStudentEventReminder(event, whenText);
      if (!sent) {
        await TimetableEvent.updateOne({ _id: event._id }, { $set: { reminder_15m_sent_at: null } });
      }
    } catch (e) {
      await TimetableEvent.updateOne({ _id: event._id }, { $set: { reminder_15m_sent_at: null } }).catch(() => {});
      console.error("[EVENT_15M_REMINDER_FAILED]", e?.message || e);
    }
  }
}

function startEventReminderScheduler() {
  const timer = setInterval(() => {
    runEventReminderTick().catch((e) => {
      console.error("[EVENT_REMINDER_TICK_FAILED]", e?.message || e);
    });
  }, CHECK_INTERVAL_MS);
  runEventReminderTick().catch((e) => {
    console.error("[EVENT_REMINDER_BOOT_FAILED]", e?.message || e);
  });
  return timer;
}

module.exports = { startEventReminderScheduler, runEventReminderTick };
