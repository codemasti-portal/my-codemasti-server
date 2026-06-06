const Assignment = require("../models/Assignment");
const Notification = require("../models/Notification");
const Student = require("../models/Student");
const { studentsInBatchesFilterResolved } = require("../utils/student-batch-context");

/**
 * In-app "new assignment" fanout. Call only when the assignment is live for students
 * (release_date <= now), so it matches list visibility in assignment.controller.js.
 */
async function fanoutAssignmentReleaseNotification(assignment) {
  const batchId = String(assignment?.batch_id || "").trim().toLowerCase();
  if (!batchId) return;
  const sectionId = String(assignment?.section_id || "").trim().toLowerCase();
  const subject = String(assignment?.subject || "").trim();
  const moduleLabel = String(assignment?.module || "").trim();
  const explicitTitle = String(assignment?.title || "").trim();
  const headline = explicitTitle || moduleLabel || subject || "New assignment";
  const deadline = assignment?.deadline_date ? new Date(assignment.deadline_date) : null;
  const deadlineText = deadline && !Number.isNaN(deadline.getTime()) ? deadline.toLocaleString() : "See portal";

  const title = "New assignment";
  const body = `${headline}${subject && headline !== subject ? ` · ${subject}` : ""}. Deadline: ${deadlineText}.`;
  const assignmentIdStr = String(assignment._id);
  const refId = `assignment:${assignmentIdStr}`;
  const deepLink = `/assignments/${assignmentIdStr}`;

  const studentFilter = await studentsInBatchesFilterResolved([batchId], { sectionId });

  const students = await Student.find(studentFilter).select("_id").lean();
  if (!students.length) return;

  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: refId,
    deep_link: deepLink,
    dedupe_key: `assignmentRelease:${assignmentIdStr}:${String(s._id)}`,
  }));

  await Notification.insertMany(docs, { ordered: true });
}

function isAssignmentReleaseLive(releaseDate) {
  const t = releaseDate ? new Date(releaseDate).getTime() : NaN;
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * One-time notify when assignment becomes visible (release_date passes). Uses DB claim to dedupe across instances/API.
 */
async function notifyAssignmentReleasedIfEligible(assignmentLean) {
  if (!assignmentLean?._id) return { notified: false, reason: "bad_doc" };
  if (!isAssignmentReleaseLive(assignmentLean.release_date)) {
    return { notified: false, reason: "not_live" };
  }
  const id = assignmentLean._id;
  const claimed = await Assignment.updateOne(
    { _id: id, release_notification_sent_at: null },
    { $set: { release_notification_sent_at: new Date() } }
  );
  if (claimed.modifiedCount !== 1) return { notified: false, reason: "already_sent" };

  try {
    await fanoutAssignmentReleaseNotification(assignmentLean);
    return { notified: true };
  } catch (e) {
    await Assignment.updateOne({ _id: id }, { $set: { release_notification_sent_at: null } }).catch(() => {});
    throw e;
  }
}

module.exports = {
  fanoutAssignmentReleaseNotification,
  isAssignmentReleaseLive,
  notifyAssignmentReleasedIfEligible,
};
