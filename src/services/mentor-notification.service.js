const MentorSlot = require("../models/MentorSlot");
const Student = require("../models/Student");
const Staff = require("../models/Staff");
const Notification = require("../models/Notification");
const { sendSimpleEmail } = require("./brevo");
const { emitEventNotification } = require("./staffPanelNotification.service");
const { studentsInBatchesFilterResolved } = require("../utils/student-batch-context");

/**
 * Bulk-insert Notification docs, tolerating duplicate dedupe_key errors (e.g. if a fan-out
 * runs twice for the same slot/student). Only rethrows genuinely unexpected errors.
 */
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

/** Student in-app fan-out when a mentor slot becomes published. */
async function fanoutMentorSlotNotification(slot) {
  const students = await resolveMentorSlotStudents(slot);
  const slotId = String(slot._id);

  if (students.length) {
    const title = "New mentor session published";
    const body = `${slot.mentor_name} mentor session on ${new Date(slot.date).toLocaleDateString()} at ${slot.time}.`;
    const refId = `mentor-slot:${slotId}`;
    const docs = students.map((s) => ({
      student_id: s._id,
      type: "system",
      title,
      body,
      read_at: null,
      ref_id: refId,
      deep_link: "/mentor-session",
      dedupe_key: `mentorSlotPublished:${slotId}:${String(s._id)}`,
    }));
    await insertNotificationsIgnoringDuplicates(docs);
  }

  // Always stamp so the publish-sweep doesn't retry forever (even with zero recipients).
  if (slot._id) {
    await MentorSlot.updateOne({ _id: slot._id }, { $set: { publish_notified_at: new Date() } });
  }
  return { created: students.length };
}

/** Mentor session cancellation: tell the targeted students (in-app) and the mentor (panel + email). */
async function notifyMentorSlotCancelled(slot) {
  const slotId = String(slot._id);
  const whenText = `${new Date(slot.date).toLocaleDateString()} at ${slot.time}`;

  const students = await resolveMentorSlotStudents(slot);
  if (students.length) {
    const title = "Mentor session cancelled";
    const body = `${slot.mentor_name} mentor session on ${whenText} was cancelled.`;
    const refId = `mentor-slot:${slotId}`;
    const docs = students.map((s) => ({
      student_id: s._id,
      type: "system",
      title,
      body,
      read_at: null,
      ref_id: refId,
      deep_link: "/mentor-session",
      dedupe_key: `mentorSlotCancelled:${slotId}:${String(s._id)}`,
    }));
    await insertNotificationsIgnoringDuplicates(docs);
  }

  const mentorName = String(slot?.mentor_name || "").trim();
  if (!mentorName) return;
  const recipients = await Staff.find({
    role: { $in: ["mentor", "instructor"] },
    is_active: true,
    name: mentorName,
  })
    .select("_id name email")
    .lean();
  for (const r of recipients) {
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(r._id),
      title: "Mentor session cancelled",
      message: `Your mentor session on ${whenText} was cancelled.`,
      category: "alerts",
      event_type: "mentor_session_cancelled",
      dedupe_key: `mentor_session_cancelled:${slotId}:${String(r._id)}`,
    });
    if (r.email) {
      try {
        await sendSimpleEmail({
          toEmail: r.email,
          subject: "Mentor session cancelled",
          htmlContent: `<p>Your mentor session on <strong>${whenText}</strong> was cancelled.</p>`,
          textContent: `Your mentor session on ${whenText} was cancelled.`,
        });
      } catch (e) {
        console.error("[MENTOR_CANCEL_EMAIL_FAILED]", e?.message || e);
      }
    }
  }
}

/**
 * Sweep: mentor slots whose publish_date has arrived but students were never notified
 * (created with a future publish_date and never edited again).
 *
 * Slots published more than 48h ago with a null flag are stamped without fan-out
 * (lazy backfill for pre-existing docs) so we never re-spam historical sessions.
 */
async function runMentorPublishSweepTick() {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const candidates = await MentorSlot.find({
    publish_date: { $lte: now },
    publish_notified_at: null,
    booking_state: { $ne: "cancelled" },
  })
    .select(
      "_id mentor_name date time meet_link publish_date publish_notified_at target_batch_ids target_section_ids target_student_ids"
    )
    .limit(100)
    .lean();

  for (const slot of candidates) {
    const publishAt = slot.publish_date ? new Date(slot.publish_date).getTime() : 0;
    const isRecent = publishAt >= recentCutoff.getTime();

    if (!isRecent) {
      // Legacy / already-visible slot — stamp without notifying.
      await MentorSlot.updateOne(
        { _id: slot._id, publish_notified_at: null },
        { $set: { publish_notified_at: slot.publish_date || now } }
      );
      continue;
    }

    const claimed = await MentorSlot.updateOne(
      { _id: slot._id, publish_notified_at: null },
      { $set: { publish_notified_at: new Date() } }
    );
    if (claimed.modifiedCount !== 1) continue;
    try {
      await fanoutMentorSlotNotification({ ...slot, publish_notified_at: new Date() });
    } catch (e) {
      await MentorSlot.updateOne({ _id: slot._id }, { $set: { publish_notified_at: null } }).catch(() => {});
      console.error("[MENTOR_PUBLISH_SWEEP_FAILED]", e?.message || e);
    }
  }
}

module.exports = {
  insertNotificationsIgnoringDuplicates,
  resolveMentorSlotStudents,
  fanoutMentorSlotNotification,
  notifyMentorSlotCancelled,
  runMentorPublishSweepTick,
};
