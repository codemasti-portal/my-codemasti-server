const TimetableSlot = require("../models/TimetableSlot");
const { notifyStudentsForSlot, buildClassStart10mEmail, fmtWhenLocal } = require("./student-notifications.service");
const {
  notifyInstructorsForSlot,
  buildClassStart10mEmail: buildInstructorClassStart10mEmail,
} = require("./instructor-notifications.service");
const { emitEventNotification } = require("./staffPanelNotification.service");

const CHECK_INTERVAL_MS = 60 * 1000;

function parseSlotStart(classDateStr, timeLabel) {
  const rawDate = String(classDateStr || "").trim();
  if (!rawDate) return null;
  const [y, m, d] = rawDate.slice(0, 10).split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

  const raw = String(timeLabel || "").trim();
  // Supports 24h "21:29 – 22:00" / "21:29 - 22:00" and 12h "09:00 AM - 10:00 AM" (we take first time).
  const m24 = raw.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (m24) return new Date(y, m - 1, d, Number(m24[1]), Number(m24[2]), 0, 0);

  const m12 = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m12) {
    let hh = Number(m12[1]);
    const mm = Number(m12[2]);
    const period = String(m12[3]).toUpperCase();
    if (period === "AM") {
      if (hh === 12) hh = 0;
    } else if (hh !== 12) {
      hh += 12;
    }
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }
  return null;
}

async function runReminderTick() {
  const now = new Date();
  const upper = new Date(now.getTime() + 10 * 60 * 1000);

  // Pull just enough candidates: today and tomorrow (handles near-midnight).
  const today = new Date(now);
  const tomorrow = new Date(now);
  today.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const fmtYMD = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dates = [fmtYMD(today), fmtYMD(tomorrow)];

  const candidates = await TimetableSlot.find({
    class_date: { $in: dates },
    $or: [
      { student_reminder_10m_sent_at: null },
      { instructor_reminder_10m_sent_at: null },
      { meet_link_missing_10m_alert_sent_at: null },
    ],
  })
    .select(
      "_id batch_id section_id class_date time subject topic teacher meet_link student_reminder_10m_sent_at instructor_reminder_10m_sent_at meet_link_missing_10m_alert_sent_at"
    )
    .lean();

  for (const slot of candidates) {
    const startsAt = parseSlotStart(slot.class_date, slot.time);
    if (!startsAt) continue;
    if (!(startsAt > now && startsAt <= upper)) continue;

    const whenText = fmtWhenLocal(slot.class_date, slot.time);
    const meet = String(slot.meet_link || "").trim();
    const meetAvailable = Boolean(meet);

    // If meet link is missing close to start time, alert instructor + admins (once).
    if (!meetAvailable && !slot.meet_link_missing_10m_alert_sent_at) {
      const claimed = await TimetableSlot.updateOne(
        { _id: slot._id, meet_link_missing_10m_alert_sent_at: null },
        { $set: { meet_link_missing_10m_alert_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          // Instructor alert (panel + email if present in staff record).
          await notifyInstructorsForSlot({
            slot,
            event_type: "timetable_meet_link_missing_10m",
            title: "Meet link missing (class starts soon)",
            message: `Meet link is missing for ${slot.subject} (${whenText}). Please add it in timetable ASAP.`,
            emailBuilder: ({ staff }) => ({
              subject: `Action required: Meet link missing (${slot.subject || "Class"})`,
              htmlContent: `<div style="font-family:Arial,sans-serif;color:#111">
                <h2 style="margin:0 0 12px">Meet link missing</h2>
                <p>Hello ${staff?.name || slot.teacher || "Instructor"},</p>
                <p>Your class starts in about <strong>10 minutes</strong>, but the Meet link is missing.</p>
                <ul>
                  <li><strong>Subject:</strong> ${slot.subject || "N/A"}</li>
                  <li><strong>When:</strong> ${whenText}</li>
                  <li><strong>Batch:</strong> ${slot.batch_id || "N/A"}</li>
                  <li><strong>Section:</strong> ${slot.section_id || "All"}</li>
                </ul>
                <p>Please add the Meet link in the timetable immediately.</p>
              </div>`,
              textContent: [
                "Meet link missing (class starts soon).",
                `Subject: ${slot.subject || "N/A"}`,
                `When: ${whenText}`,
                `Batch: ${slot.batch_id || "N/A"}`,
                `Section: ${slot.section_id || "All"}`,
                "Please add the Meet link in the timetable immediately.",
              ].join("\n"),
            }),
          });

          // Admin alert (staff panel, deduped).
          const slotId = String(slot._id);
          await emitEventNotification({
            audience: "role",
            target_roles: ["super_admin", "admin"],
            title: "Meet link missing (class starts soon)",
            message: `Meet link is missing for ${slot.subject} (${whenText}). Batch: ${slot.batch_id}${slot.section_id ? `, Section: ${slot.section_id}` : ""}.`,
            category: "alerts",
            event_type: "timetable_meet_link_missing_10m",
            dedupe_key: `timetable_meet_link_missing_10m:${slotId}:role:admin`,
          });
        } catch (e) {
          // Roll back so it can retry if something failed unexpectedly.
          await TimetableSlot.updateOne({ _id: slot._id }, { $set: { meet_link_missing_10m_alert_sent_at: null } }).catch(
            () => {}
          );
          console.error("[MEET_LINK_MISSING_10M_ALERT_FAILED]", e?.message || e);
        }
      }
    }

    // Student reminders should send only when Meet link exists.
    if (meetAvailable && !slot.student_reminder_10m_sent_at) {
      const claimed = await TimetableSlot.updateOne(
        { _id: slot._id, student_reminder_10m_sent_at: null },
        { $set: { student_reminder_10m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          await notifyStudentsForSlot({
            slot,
            type: "class_start_10m",
            title: "Class starts in 10 minutes",
            body: `Your class ${slot.subject} starts in 10 minutes (${whenText}).`,
            deep_link: "/timetable",
            dedupePrefix: "class10m",
            email: ({ student }) => buildClassStart10mEmail({ studentName: student?.name, slot }),
          });
        } catch (e) {
          // Best-effort rollback so a failed send can retry on a later tick.
          await TimetableSlot.updateOne({ _id: slot._id }, { $set: { student_reminder_10m_sent_at: null } }).catch(
            () => {}
          );
          console.error("[STUDENT_CLASS_10M_REMINDER_FAILED]", e?.message || e);
        }
      }
    }

    // Instructor reminders can still be sent even if meet link is missing (they should know either way).
    if (!slot.instructor_reminder_10m_sent_at) {
      const claimed = await TimetableSlot.updateOne(
        { _id: slot._id, instructor_reminder_10m_sent_at: null },
        { $set: { instructor_reminder_10m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const { notified } = await notifyInstructorsForSlot({
            slot,
            event_type: "timetable_class_reminder_10m",
            title: "Class starts in 10 minutes",
            message: `${slot.subject} starts in 10 minutes (${whenText}). Batch: ${slot.batch_id}${
              slot.section_id ? `, Section: ${slot.section_id}` : ""
            }.`,
            emailBuilder: ({ staff }) => buildInstructorClassStart10mEmail({ staffName: staff?.name, slot }),
          });
          if (!notified) {
            await TimetableSlot.updateOne({ _id: slot._id }, { $set: { instructor_reminder_10m_sent_at: null } });
          }
        } catch (e) {
          await TimetableSlot.updateOne({ _id: slot._id }, { $set: { instructor_reminder_10m_sent_at: null } }).catch(
            () => {}
          );
          console.error("[INSTRUCTOR_CLASS_10M_REMINDER_FAILED]", e?.message || e);
        }
      }
    }
  }
}

function startTimetableClassReminderScheduler() {
  const timer = setInterval(() => {
    runReminderTick().catch((e) => console.error("[TIMETABLE_CLASS_REMINDER_TICK_FAILED]", e?.message || e));
  }, CHECK_INTERVAL_MS);
  runReminderTick().catch((e) => console.error("[TIMETABLE_CLASS_REMINDER_BOOT_FAILED]", e?.message || e));
  return timer;
}

module.exports = { startTimetableClassReminderScheduler };
