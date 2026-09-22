const { z } = require("zod");
const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const Assignment = require("../models/Assignment");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const Student = require("../models/Student");
const Staff = require("../models/Staff");
const StudentEnrollment = require("../models/StudentEnrollment");
const {
  getInstructorAssignedBatchIds,
  assignmentDocTouchesAllowedBatches,
} = require("../utils/instructorBatchScope");
const { isProjectAssignmentType } = require("../utils/projectQuestionPolicy");
const {
  PROJECT_KIND,
  REVIEW_EVALUATED,
  validateAwardedMarks,
  serializeProjectSubmissionForStaff,
} = require("../services/project-submission.service");

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function normId(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Section for this assignment's batch from active enrollment.
 * Falls back to the Student profile section only when that profile batch matches the assignment batch.
 */
async function overlayAssignmentBatchSections(students, assignmentBatchId) {
  const bid = normId(assignmentBatchId);
  const list = Array.isArray(students) ? students.filter(Boolean) : [];
  if (!list.length || !bid) return list;
  const ids = list.map((s) => s._id).filter(Boolean);
  const rows = await StudentEnrollment.find({
    student_id: { $in: ids },
    status: "active",
    batch_id: bid,
  })
    .select("student_id section_id updatedAt")
    .lean();
  const sectionByStudent = new Map();
  for (const row of rows) {
    const sid = String(row.student_id);
    const section = normId(row.section_id);
    const prev = sectionByStudent.get(sid);
    if (!prev || (row.updatedAt && prev.at < new Date(row.updatedAt).getTime())) {
      sectionByStudent.set(sid, { section, at: row.updatedAt ? new Date(row.updatedAt).getTime() : 0 });
    }
  }
  return list.map((student) => {
    const fromEnroll = sectionByStudent.get(String(student._id));
    if (fromEnroll?.section) {
      return { ...student, section_id: fromEnroll.section, batch_id: bid };
    }
    if (normId(student.batch_id) === bid) {
      return student;
    }
    return { ...student, section_id: "" };
  });
}

async function loadStaffScopedProjectAssignment(req, res) {
  if (!isObjectId(req.params.assignmentId || req.params.id)) {
    sendError(res, 400, "INVALID_ID", "Invalid assignment id.");
    return null;
  }
  const assignment = await Assignment.findById(req.params.assignmentId || req.params.id).lean();
  if (!assignment) {
    sendError(res, 404, "NOT_FOUND", "Assignment not found");
    return null;
  }
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(assignment, instructorBatches)) {
    sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
    return null;
  }
  if (!isProjectAssignmentType(assignment.assignment_type)) {
    sendError(res, 400, "INVALID_ASSIGNMENT_TYPE", "This assignment is not a project.");
    return null;
  }
  return assignment;
}

function staffSubmissionQuery(assignmentId, extra = {}) {
  return { assignment_id: assignmentId, kind: PROJECT_KIND, status: "Accepted", ...extra };
}

async function listProjectSubmissions(req, res) {
  const assignment = await loadStaffScopedProjectAssignment(req, res);
  if (!assignment) return;

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const reviewStatus = String(req.query.review_status || "").trim().toLowerCase();
  const studentId = String(req.query.student_id || "").trim();
  const sectionId = String(req.query.section_id || "").trim().toLowerCase();
  const search = String(req.query.q || req.query.search || "").trim();

  const filter = staffSubmissionQuery(assignment._id);
  if (reviewStatus === "pending" || reviewStatus === "evaluated") {
    filter["project.review_status"] = reviewStatus;
  }

  let allowedStudentIds = null;
  if (studentId) {
    if (!isObjectId(studentId)) {
      return sendError(res, 400, "INVALID_ID", "Invalid student_id.");
    }
    allowedStudentIds = [studentId];
  }

  if (sectionId) {
    const batchId = String(assignment.batch_id || "").toLowerCase();
    const enrolled = await StudentEnrollment.find({
      status: "active",
      batch_id: batchId,
      section_id: sectionId,
    })
      .select("student_id")
      .lean();
    const sectionStudentIds = enrolled.map((r) => String(r.student_id));
    allowedStudentIds = allowedStudentIds
      ? allowedStudentIds.filter((id) => sectionStudentIds.includes(String(id)))
      : sectionStudentIds;
  }

  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const students = await Student.find({
      $or: [
        { name: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
        { enrollment_number: { $regex: escaped, $options: "i" } },
      ],
    })
      .select("_id")
      .lean();
    const searchIds = students.map((s) => String(s._id));
    allowedStudentIds = allowedStudentIds
      ? allowedStudentIds.filter((id) => searchIds.includes(String(id)))
      : searchIds;
  }

  if (allowedStudentIds) {
    if (!allowedStudentIds.length) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    filter.student_id = { $in: allowedStudentIds };
  }

  const [docs, total] = await Promise.all([
    AssignmentSubmission.find(filter).sort({ submitted_at: -1 }).skip(skip).limit(limit).lean(),
    AssignmentSubmission.countDocuments(filter),
  ]);

  const studentIds = [...new Set(docs.map((d) => String(d.student_id)))];
  const reviewerIds = [...new Set(docs.map((d) => d.project?.reviewed_by).filter(Boolean).map(String))];
  const [students, reviewers] = await Promise.all([
    studentIds.length
      ? Student.find({ _id: { $in: studentIds } })
          .select("name email enrollment_number batch_id section_id avatar_url")
          .lean()
      : [],
    reviewerIds.length ? Staff.find({ _id: { $in: reviewerIds } }).select("name email").lean() : [],
  ]);
  const studentById = new Map(students.map((s) => [String(s._id), s]));
  const reviewerById = new Map(reviewers.map((s) => [String(s._id), s]));
  const overlayed = await overlayAssignmentBatchSections([...studentById.values()], assignment.batch_id);
  const overlayById = new Map(overlayed.map((s) => [String(s._id), s]));

  const items = docs.map((doc) =>
    serializeProjectSubmissionForStaff(doc, {
      assignment,
      student: overlayById.get(String(doc.student_id)) || studentById.get(String(doc.student_id)),
      reviewer: reviewerById.get(String(doc.project?.reviewed_by || "")),
    })
  );

  return sendSuccess(res, items, "", { page, limit, total });
}

async function getProjectSubmission(req, res) {
  const assignment = await loadStaffScopedProjectAssignment(req, res);
  if (!assignment) return;
  if (!isObjectId(req.params.submissionId)) {
    return sendError(res, 400, "INVALID_ID", "Invalid submission id.");
  }
  const doc = await AssignmentSubmission.findOne(
    staffSubmissionQuery(assignment._id, { _id: req.params.submissionId })
  ).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Project submission not found");
  if (req.query.student_id && String(doc.student_id) !== String(req.query.student_id)) {
    return sendError(res, 404, "NOT_FOUND", "Project submission not found");
  }
  const [student, reviewer] = await Promise.all([
    Student.findById(doc.student_id).select("name email enrollment_number batch_id section_id avatar_url").lean(),
    doc.project?.reviewed_by
      ? Staff.findById(doc.project.reviewed_by).select("name email").lean()
      : null,
  ]);
  const [overlayed] = await overlayAssignmentBatchSections(student ? [student] : [], assignment.batch_id);
  return sendSuccess(res, serializeProjectSubmissionForStaff(doc, { assignment, student: overlayed || student, reviewer }));
}

async function evaluateProjectSubmission(req, res) {
  const assignment = await loadStaffScopedProjectAssignment(req, res);
  if (!assignment) return;
  if (!isObjectId(req.params.submissionId)) {
    return sendError(res, 400, "INVALID_ID", "Invalid submission id.");
  }

  const schema = z.object({
    marks: z.coerce.number(),
    feedback: z.string().max(10000).optional().default(""),
    student_id: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const marksCheck = validateAwardedMarks(body.marks, assignment.project_max_marks);
  if (!marksCheck.ok) {
    return sendError(res, 400, marksCheck.code, marksCheck.message);
  }

  const doc = await AssignmentSubmission.findOne(
    staffSubmissionQuery(assignment._id, { _id: req.params.submissionId })
  );
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Project submission not found");
  if (body.student_id && String(doc.student_id) !== String(body.student_id)) {
    return sendError(res, 400, "STUDENT_MISMATCH", "This submission does not belong to the specified student.");
  }
  if (String(doc.status) !== "Accepted" || String(doc.kind) !== PROJECT_KIND) {
    return sendError(res, 409, "PROJECT_NOT_SUBMITTED", "This project has not been successfully submitted.");
  }

  const reviewerId = req.staff?.sub;
  const prev = doc.project && typeof doc.project.toObject === "function" ? doc.project.toObject() : doc.project || {};
  doc.project = {
    explanation_video_url: prev.explanation_video_url || "",
    demo_video_url: prev.demo_video_url || "",
    github_repository_url: prev.github_repository_url || "",
    review_status: REVIEW_EVALUATED,
    marks: marksCheck.value,
    feedback: String(body.feedback || "").slice(0, 10000),
    reviewed_by: reviewerId || prev.reviewed_by || null,
    evaluated_at: new Date(),
  };
  await doc.save();

  const lean = doc.toObject();
  const [student, reviewer] = await Promise.all([
    Student.findById(doc.student_id).select("name email enrollment_number batch_id section_id avatar_url").lean(),
    lean.project?.reviewed_by
      ? Staff.findById(lean.project.reviewed_by).select("name email").lean()
      : null,
  ]);
  const [overlayed] = await overlayAssignmentBatchSections(student ? [student] : [], assignment.batch_id);
  return sendSuccess(
    res,
    serializeProjectSubmissionForStaff(lean, { assignment, student: overlayed || student, reviewer }),
    "Evaluated"
  );
}

module.exports = {
  listProjectSubmissions,
  getProjectSubmission,
  evaluateProjectSubmission,
};
