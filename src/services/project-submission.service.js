const AssignmentQuestion = require("../models/AssignmentQuestion");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const AssignmentXpGrant = require("../models/AssignmentXpGrant");
const { hasProjectDocumentContent } = require("../utils/projectDocument");
const { isProjectAssignmentType } = require("../utils/projectQuestionPolicy");
const {
  fullQuestionXp,
  lateXpAmount,
  xpAwardedForAccepted,
  submittedAtOrBeforeDeadline,
} = require("../utils/assignmentXp");

const PROJECT_KIND = "project";
const REVIEW_PENDING = "pending";
const REVIEW_EVALUATED = "evaluated";

function isDuplicateKeyError(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}

function normalizeProjectMaxMarks(value, fallback = 100) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1000, Math.max(0, Math.round(n * 10) / 10));
}

function roundMarks(value) {
  return Math.round(Number(value) * 10) / 10;
}

function validateAwardedMarks(marks, maxMarks) {
  const max = Number(maxMarks);
  if (!Number.isFinite(max) || max <= 0) {
    return {
      ok: false,
      code: "PROJECT_MAX_MARKS_REQUIRED",
      message: "This project has no maximum marks configured. Set project_max_marks before evaluating.",
    };
  }
  const n = Number(marks);
  if (!Number.isFinite(n)) {
    return { ok: false, code: "INVALID_MARKS", message: "marks must be a finite number." };
  }
  if (n < 0) {
    return { ok: false, code: "INVALID_MARKS", message: "marks cannot be negative." };
  }
  const rounded = roundMarks(n);
  if (rounded > max) {
    return {
      ok: false,
      code: "MARKS_EXCEED_MAXIMUM",
      message: `marks cannot exceed the project maximum of ${max}.`,
    };
  }
  return { ok: true, value: rounded, max };
}

async function resolveCanonicalProjectQuestion(assignmentId) {
  const questions = await AssignmentQuestion.find({ assignment_id: assignmentId })
    .sort({ createdAt: 1 })
    .lean();
  if (!questions.length) {
    return {
      ok: false,
      code: "PROJECT_NOT_READY",
      message: "This project has no document question yet, so it cannot accept submissions.",
    };
  }
  if (questions.length > 1) {
    return {
      ok: false,
      code: "PROJECT_AMBIGUOUS",
      message:
        "This project has multiple questions from before the one-document policy. New submissions are blocked until staff leaves a single project document question.",
    };
  }
  const question = questions[0];
  if (!hasProjectDocumentContent(question.project_document)) {
    return {
      ok: false,
      code: "PROJECT_DOCUMENT_INCOMPLETE",
      message: "This project document is empty. Submissions are blocked until the document is authored.",
    };
  }
  return { ok: true, question };
}

function findExistingProjectSubmissionFilter(assignmentId, studentId) {
  return {
    assignment_id: assignmentId,
    student_id: studentId,
    kind: PROJECT_KIND,
  };
}

async function findExistingProjectSubmission(assignmentId, studentId) {
  return AssignmentSubmission.findOne(findExistingProjectSubmissionFilter(assignmentId, studentId)).lean();
}

async function ensureProjectXpGrant({ assignment, question, studentId, submission, submittedAt }) {
  const xpFull = fullQuestionXp(question.xp);
  const xpCandidate = xpAwardedForAccepted(question.xp, submittedAt, assignment.deadline_date);
  const filter = {
    assignment_id: assignment._id || assignment.id,
    question_id: question._id,
    student_id: studentId,
  };
  await AssignmentXpGrant.updateOne(
    filter,
    {
      $setOnInsert: {
        xp_awarded: xpCandidate,
        full_xp: xpFull,
        submitted_before_deadline: submittedAtOrBeforeDeadline(submittedAt, assignment.deadline_date),
        submitted_at: submittedAt,
        deadline_date: assignment.deadline_date || null,
        granted_at: new Date(),
        source_submission_id: submission._id,
      },
    },
    { upsert: true }
  );
  await AssignmentXpGrant.updateOne(filter, { $set: { source_submission_id: submission._id } });
  const grant = await AssignmentXpGrant.findOne(filter).lean();
  const xpOnGrant = Number(grant?.xp_awarded || 0);
  if (Number(submission.xp_awarded || 0) !== xpOnGrant) {
    await AssignmentSubmission.updateOne({ _id: submission._id }, { $set: { xp_awarded: xpOnGrant } });
    submission.xp_awarded = xpOnGrant;
  }
  return {
    xp_awarded: xpOnGrant,
    xp_if_on_time: xpFull,
    xp_if_late: lateXpAmount(xpFull),
    submitted_before_deadline: Boolean(grant?.submitted_before_deadline),
  };
}

function projectPayloadFromDoc(doc) {
  const p = doc?.project && typeof doc.project === "object" ? doc.project : {};
  const reviewStatus = String(p.review_status || REVIEW_PENDING).toLowerCase() === REVIEW_EVALUATED
    ? REVIEW_EVALUATED
    : REVIEW_PENDING;
  const evaluated = reviewStatus === REVIEW_EVALUATED;
  return {
    explanation_video_url: p.explanation_video_url || "",
    demo_video_url: p.demo_video_url || "",
    github_repository_url: p.github_repository_url || "",
    review_status: reviewStatus,
    marks: evaluated && p.marks != null && Number.isFinite(Number(p.marks)) ? Number(p.marks) : null,
    feedback: evaluated ? String(p.feedback || "") : "",
    evaluated_at: evaluated && p.evaluated_at ? p.evaluated_at : null,
    reviewed_by: p.reviewed_by ? String(p.reviewed_by) : "",
  };
}

function serializeProjectSubmissionForStudent(doc, { assignment, question } = {}) {
  const payload = projectPayloadFromDoc(doc);
  const maxMarks = normalizeProjectMaxMarks(assignment?.project_max_marks, 100);
  const xpFull = fullQuestionXp(question?.xp);
  const submittedAt = doc.submitted_at;
  return {
    submission_id: String(doc._id),
    assignment_id: String(doc.assignment_id),
    question_id: String(doc.question_id),
    submitted_at: submittedAt,
    status: doc.status || "Accepted",
    review_status: payload.review_status,
    submission_state: payload.review_status === REVIEW_EVALUATED ? "evaluated" : "submitted",
    explanation_video_url: payload.explanation_video_url,
    demo_video_url: payload.demo_video_url,
    github_repository_url: payload.github_repository_url,
    xp_awarded: Number(doc.xp_awarded || 0),
    xp_if_on_time: xpFull,
    xp_if_late: lateXpAmount(xpFull),
    submitted_before_deadline: submittedAtOrBeforeDeadline(submittedAt, assignment?.deadline_date),
    project_max_marks: maxMarks,
    marks: payload.review_status === REVIEW_EVALUATED ? payload.marks : null,
    feedback: payload.review_status === REVIEW_EVALUATED ? payload.feedback : "",
    evaluated_at: payload.evaluated_at,
  };
}

function serializeProjectSubmissionForStaff(doc, { assignment, student, reviewer } = {}) {
  const payload = projectPayloadFromDoc(doc);
  const maxMarks = normalizeProjectMaxMarks(assignment?.project_max_marks, 100);
  return {
    submission_id: String(doc._id),
    assignment_id: String(doc.assignment_id),
    question_id: String(doc.question_id),
    student: student
      ? {
          id: String(student._id),
          name: student.name || "",
          email: student.email || "",
          enrollment_number: student.enrollment_number || "",
          batch_id: student.batch_id || "",
          section_id: student.section_id || "",
          avatar_url: student.avatar_url || "",
        }
      : { id: String(doc.student_id) },
    submitted_at: doc.submitted_at,
    status: doc.status || "Accepted",
    review_status: payload.review_status,
    explanation_video_url: payload.explanation_video_url,
    demo_video_url: payload.demo_video_url,
    github_repository_url: payload.github_repository_url,
    xp_awarded: Number(doc.xp_awarded || 0),
    project_max_marks: maxMarks,
    marks: payload.marks,
    feedback: payload.feedback,
    evaluated_at: payload.evaluated_at,
    reviewed_by: payload.reviewed_by
      ? {
          id: payload.reviewed_by,
          name: reviewer?.name || "",
          email: reviewer?.email || "",
        }
      : null,
  };
}

module.exports = {
  PROJECT_KIND,
  REVIEW_PENDING,
  REVIEW_EVALUATED,
  isDuplicateKeyError,
  isProjectAssignmentType,
  normalizeProjectMaxMarks,
  validateAwardedMarks,
  resolveCanonicalProjectQuestion,
  findExistingProjectSubmission,
  findExistingProjectSubmissionFilter,
  ensureProjectXpGrant,
  serializeProjectSubmissionForStudent,
  serializeProjectSubmissionForStaff,
  projectPayloadFromDoc,
};
