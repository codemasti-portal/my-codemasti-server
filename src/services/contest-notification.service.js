const Student = require("../models/Student");
const { insertNotificationsIgnoringDuplicates } = require("./mentor-notification.service");
const { studentsInBatchesFilterResolved } = require("../utils/student-batch-context");

async function resolveContestStudents(contest) {
  const batchId = String(contest?.batch_id || "")
    .trim()
    .toLowerCase();
  if (!batchId) return [];
  const sectionIds = Array.isArray(contest?.section_ids)
    ? contest.section_ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean)
    : [];
  const filter = await studentsInBatchesFilterResolved([batchId], {
    sectionIds: sectionIds.length > 0 ? sectionIds : undefined,
  });
  return Student.find(filter).select("_id").lean();
}

/** Fan-out when a contest becomes published (create with is_published, or patch false→true). */
async function fanoutContestPublished(contest) {
  const students = await resolveContestStudents(contest);
  if (!students.length) return { created: 0 };
  const contestId = String(contest._id || contest.id);
  const startLabel = contest.start_at
    ? new Date(contest.start_at).toLocaleString()
    : "";
  const title = "New contest published";
  const body = startLabel
    ? `${contest.title} is now available (starts ${startLabel}).`
    : `${contest.title} is now available.`;
  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: `contest:${contestId}`,
    deep_link: "/contests",
    dedupe_key: `contestPublished:${contestId}:${String(s._id)}`,
  }));
  await insertNotificationsIgnoringDuplicates(docs);
  return { created: docs.length };
}

/** Fan-out when a published contest is deleted. */
async function fanoutContestCancelled(contest) {
  if (!contest?.is_published) return { created: 0 };
  const students = await resolveContestStudents(contest);
  if (!students.length) return { created: 0 };
  const contestId = String(contest._id || contest.id);
  const title = "Contest cancelled";
  const body = `${contest.title} has been cancelled.`;
  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: `contest:${contestId}`,
    deep_link: "/contests",
    dedupe_key: `contestCancelled:${contestId}:${String(s._id)}`,
  }));
  await insertNotificationsIgnoringDuplicates(docs);
  return { created: docs.length };
}

module.exports = {
  fanoutContestPublished,
  fanoutContestCancelled,
};
