const { sendSuccess } = require("../utils/response");
const Student = require("../models/Student");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { assignmentPublishedVisibleToCatalogBatch } = require("../utils/assignmentBatchFilter");
const { filterAssignmentsOpenToStudents } = require("../utils/projectPublication");
const { scopeStudentToBatch, membershipKeysOr } = require("../utils/student-batch-context");
const { isAssignmentVisibleToStudent } = require("../utils/assignmentEligibility");
const { pickDashboardContestCard, loadStudent } = require("../controllers/contest.controller");

function visibleAssignmentsQueryForStudent(student, now = new Date()) {
  const enriched = augmentStudentCatalogFieldsFromEnrollment(student);
  const legacy = [String(enriched?.batch_id || "").toLowerCase().trim()].filter(Boolean);
  // Read-switch: legacy = single batch (byte-identical); non-legacy = OR over the full membership set.
  const attached = student && Array.isArray(student.__membershipBatchIds);
  const batchIds = membershipKeysOr(student, legacy);
  // Non-legacy student in zero batches sees NO batch-scoped assignments. (Legacy keeps its
  // batch-less "all published" behavior — which only applies when nothing is attached.)
  if (attached && batchIds.length === 0) return { _id: null };
  if (batchIds.length <= 1) {
    return assignmentPublishedVisibleToCatalogBatch(batchIds[0] || "", now);
  }
  return { $or: batchIds.map((b) => assignmentPublishedVisibleToCatalogBatch(b, now)) };
}

async function summary(req, res) {
  const studentId = req.user.sub;

  const rawStudent = await Student.findById(studentId).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!rawStudent) {
    return sendSuccess(res, {
      latest_releases: 0,
      pending_assignments: 0,
      performance_score: 0,
      pending_questions_count: 0,
    });
  }
  await scopeStudentToBatch(req, student);
  const now = new Date();
  const assignmentQuery = visibleAssignmentsQueryForStudent(student, now);
  const rawAssignments = await Assignment.find(assignmentQuery).lean();
  const studentVisible = rawAssignments.filter((a) => isAssignmentVisibleToStudent(a, student, now));
  const assignments = await filterAssignmentsOpenToStudents(studentVisible);

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

async function home(req, res) {
  const student = await loadStudent(req);
  if (!student) {
    return sendSuccess(res, {
      latest_releases: [],
      pending_assignments: [],
      pending_questions_count: 0,
      performance_score: 0,
      contest_card: null,
      counters: { latest_releases: 0, pending_assignments: 0 },
    });
  }

  const contest_card = await pickDashboardContestCard(student, new Date());

  return sendSuccess(res, {
    latest_releases: [],
    pending_assignments: [],
    pending_questions_count: 0,
    performance_score: student?.progress ?? 0,
    contest_card,
    counters: {
      latest_releases: 0,
      pending_assignments: 0,
    },
  });
}

module.exports = { summary, home };
