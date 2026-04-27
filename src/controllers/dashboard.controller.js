const { sendSuccess } = require("../utils/response");
const Student = require("../models/Student");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const AssignmentSubmission = require("../models/AssignmentSubmission");

function visibleAssignmentsQueryForStudent(student, now = new Date()) {
  const published = { release_date: { $lte: now } };
  const sbatch = String(student?.batch_id || "").toLowerCase().trim();
  if (!sbatch) return published;
  return {
    $and: [
      published,
      {
        $or: [
          { batch_id: { $exists: false } },
          { batch_id: "" },
          {
            $expr: {
              $eq: [{ $toLower: { $trim: { input: { $ifNull: ["$batch_id", ""] } } } }, sbatch],
            },
          },
        ],
      },
    ],
  };
}

async function summary(req, res) {
  const studentId = req.user.sub;

  const student = await Student.findById(studentId).lean();
  if (!student) {
    return sendSuccess(res, {
      latest_releases: 0,
      pending_assignments: 0,
      performance_score: 0,
      pending_questions_count: 0,
    });
  }
  const now = new Date();
  const assignmentQuery = visibleAssignmentsQueryForStudent(student, now);
  const assignments = await Assignment.find(assignmentQuery).lean();

  const assignmentIds = assignments.map((a) => a._id);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const latest_releases = assignments.filter(
    (a) => a.release_date && new Date(a.release_date) >= thirtyDaysAgo
  ).length;

  if (!assignmentIds.length) {
    return sendSuccess(res, {
      latest_releases,
      pending_assignments: 0,
      performance_score: student?.progress ?? 0,
      pending_questions_count: 0,
    });
  }

  const questions = await AssignmentQuestion.find({ assignment_id: { $in: assignmentIds } }).lean();
  const acceptedRows = await AssignmentSubmission.find({
    student_id: studentId,
    status: "Accepted",
  })
    .select("question_id assignment_id")
    .lean();
  const acceptedQ = new Set(acceptedRows.map((r) => String(r.question_id)));

  const pendingQs = questions.filter((q) => !acceptedQ.has(String(q._id)));
  const pending_assignments = new Set(pendingQs.map((q) => String(q.assignment_id))).size;
  const pending_questions_count = pendingQs.length;

  return sendSuccess(res, {
    latest_releases,
    pending_assignments,
    performance_score: student?.progress ?? 0,
    pending_questions_count,
  });
}

module.exports = { summary };
