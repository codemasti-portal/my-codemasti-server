const TimetableSlot = require("../models/TimetableSlot");
const { notifyStudentsForSlot, buildClassStart10mEmail, fmtWhenLocal } = require("./student-notifications.service");
const {
  notifyInstructorsForSlot,
  buildClassStart60mEmail: buildInstructorClassStart60mEmail,
} = require("./instructor-notifications.service");
const { emitEventNotification } = require("./staffPanelNotification.service");
const {
  parseSlotStart,
  buildClassStartReminderCopy,
  formatDateYmdInClassTimeZone,
} = require("../utils/timetable-slot-start");

const CHECK_INTERVAL_MS = 60 * 1000;

async function runReminderTick() {
  const now = new Date();
  const tenMin = new Date(now.getTime() + 10 * 60 * 1000);
  const sixtyMin = new Date(now.getTime() + 60 * 60 * 1000);
  const livePast = new Date(now.getTime() - 5 * 60 * 1000); // class_live fires up to 5 min after start

  // Pull just enough candidates: yesterday/today/tomorrow IN THE CLASS TIMEZONE (not server-local —
  // Vercel runs in UTC, and CLASS_TIMEZONE may differ, so the "current day" there can be a
  // different calendar date than the server's). Includes yesterday too so a class-timezone
  // "today" that is the server's "yesterday" (timezone behind UTC) is never missed.
  const dates = [
    formatDateYmdInClassTimeZone(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    formatDateYmdInClassTimeZone(now),
    formatDateYmdInClassTimeZone(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
  ].filter(Boolean);

  const candidates = await TimetableSlot.find({
    class_date: { $in: dates },
    $or: [
      { instructor_reminder_60m_sent_at: null },
      { student_reminder_10m_sent_at: null },
      { meet_link_missing_10m_alert_sent_at: null },
      { class_live_sent_at: null },
    ],
  })
    .select(
      "_id batch_id section_id class_date time subject topic teacher staff_id meet_link instructor_reminder_60m_sent_at student_reminder_10m_sent_at meet_link_missing_10m_alert_sent_at class_live_sent_at"
    )
    .lean();

  for (const slot of candidates) {
    const startsAt = parseSlotStart(slot.class_date, slot.time);
    if (!startsAt) continue;
    // Only process slots near the relevant windows: starting within the next hour,
    // or started within the last 5 minutes (for the "class is live" ping).
    if (startsAt > sixtyMin || startsAt < livePast) continue;

    const whenText = fmtWhenLocal(slot.class_date, slot.time);
    const meet = String(slot.meet_link || "").trim();
    const meetAvailable = Boolean(meet);

    // ── Instructor: "class starts in ~1 hour" email (fires as soon as the class is
    //    within 60 min; if scheduled with less lead time, it sends right away). ──
    if (startsAt > now && startsAt <= sixtyMin && !slot.instructor_reminder_60m_sent_at) {
      const claimed = await TimetableSlot.updateOne(
        { _id: slot._id, instructor_reminder_60m_sent_at: null },
        { $set: { instructor_reminder_60m_sent_at: new Date(), instructor_reminder_60m_meet_link: meet } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const { notified } = await notifyInstructorsForSlot({
            slot,
            event_type: "timetable_class_reminder_60m",
            title: "Class starts in 1 hour",
            message: `${slot.subject} starts in about 1 hour (${whenText}). Batch: ${slot.batch_id}${
              slot.section_id ? `, Section: ${slot.section_id}` : ""
            }.${meet ? ` Meet: ${meet}` : ""}`,
            action_url: "/dashboard/instructor/timetable?focus=today",
            emailBuilder: ({ staff }) => buildInstructorClassStart60mEmail({ staffName: staff?.name, slot }),
          });
          // No instructor to notify (no email + no staff record) — roll back so a later
          // tick can retry once staff_id/email becomes available.
          if (!notified) {
            await TimetableSlot.updateOne(
              { _id: slot._id },
              { $set: { instructor_reminder_60m_sent_at: null, instructor_reminder_60m_meet_link: "" } }
            );
          }
        } catch (e) {
          await TimetableSlot.updateOne(
            { _id: slot._id },
            { $set: { instructor_reminder_60m_sent_at: null, instructor_reminder_60m_meet_link: "" } }
          ).catch(() => {});
          console.error("[INSTRUCTOR_CLASS_60M_REMINDER_FAILED]", e?.message || e);
        }
      }
    }

    // If meet link is missing close to start time (~10 min), alert instructor + admins (once).
    if (!meetAvailable && startsAt > now && startsAt <= tenMin && !slot.meet_link_missing_10m_alert_sent_at) {
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

    // Student reminders (~10 min before) send only when Meet link exists.
    if (meetAvailable && startsAt > now && startsAt <= tenMin && !slot.student_reminder_10m_sent_at) {
      const claimed = await TimetableSlot.updateOne(
        { _id: slot._id, student_reminder_10m_sent_at: null },
        { $set: { student_reminder_10m_sent_at: new Date() } }
      );
      if (claimed.modifiedCount === 1) {
        try {
          const minsUntil = Math.max(1, Math.round((startsAt.getTime() - now.getTime()) / 60_000));
          const { title, body } = buildClassStartReminderCopy(minsUntil, slot, whenText);
          await notifyStudentsForSlot({
            slot,
            type: "class_start_10m",
            title,
            body,
            deep_link: "/timetable",
            meet_url: meet,
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

    // "Class is now live" — fires within 5 minutes after scheduled start (requires meet link).
    if (meetAvailable && !slot.class_live_sent_at) {
      if (startsAt <= now && now <= new Date(startsAt.getTime() + 5 * 60 * 1000)) {
        const claimed = await TimetableSlot.updateOne(
          { _id: slot._id, class_live_sent_at: null },
          { $set: { class_live_sent_at: new Date() } }
        );
        if (claimed.modifiedCount === 1) {
          try {
            await notifyStudentsForSlot({
              slot,
              type: "class_live",
              title: "Class is live now!",
              body: `${slot.subject} is live now. Join via Meet link.`,
              deep_link: "/timetable",
              meet_url: meet,
              dedupePrefix: "classLive",
            });
          } catch (e) {
            await TimetableSlot.updateOne({ _id: slot._id }, { $set: { class_live_sent_at: null } }).catch(() => {});
            console.error("[STUDENT_CLASS_LIVE_FAILED]", e?.message || e);
          }
        }
      }
    }
    // (Instructors get the 1-hour email above instead of a 10-minute one.)
  }
}

function startTimetableClassReminderScheduler() {
  const timer = setInterval(() => {
    runReminderTick().catch((e) => console.error("[TIMETABLE_CLASS_REMINDER_TICK_FAILED]", e?.message || e));
  }, CHECK_INTERVAL_MS);
  runReminderTick().catch((e) => console.error("[TIMETABLE_CLASS_REMINDER_BOOT_FAILED]", e?.message || e));
  return timer;
}

module.exports = { startTimetableClassReminderScheduler, runReminderTick };
