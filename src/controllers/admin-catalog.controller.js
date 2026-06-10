const { z } = require("zod");
const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaQuestion = require("../models/ArenaQuestion");
const ArenaSubmission = require("../models/ArenaSubmission");
const LiveClass = require("../models/LiveClass");
const TimetableSlot = require("../models/TimetableSlot");
const TimetableEvent = require("../models/TimetableEvent");
const MentorSlot = require("../models/MentorSlot");
const Student = require("../models/Student");
const Staff = require("../models/Staff");
const Notification = require("../models/Notification");
const { sendSimpleEmail } = require("../services/brevo");
const {
  notifyStudentsForSlot,
  buildResourceUploadedEmail,
  fmtWhenLocal,
} = require("../services/student-notifications.service");
const {
  notifyInstructorsForSlot,
  buildResourceUploadedEmail: buildInstructorResourceEmail,
} = require("../services/instructor-notifications.service");
const { studentsInCatalogBatchesFilter, catalogBatchStudentFilter } = require("../utils/enrollment");
const { studentsInBatchesFilterResolved, catalogBatchStudentFilterResolved } = require("../utils/student-batch-context");
const { assignmentMatchesCatalogBatchId } = require("../utils/assignmentBatchFilter");
const googleMeetCal = require("../services/google-calendar-meet.service");
const { notifyAssignmentReleasedIfEligible } = require("../services/assignment-notifications.service");
const { ROLES } = require("../utils/rbac");
const {
  getInstructorAssignedBatchIds,
  assignmentDocTouchesAllowedBatches,
  arenaDocTouchesAllowedBatches,
} = require("../utils/instructorBatchScope");
const { validateBatchSubject, invalidSubjectMessage } = require("../utils/catalog-subjects");

/**
 * Single-source-of-truth subject guard: a provided subject must match the targeted batch(es) catalog
 * (case-insensitive). Returns { ok, value } where value is the canonical casing to store. An empty /
 * omitted subject is allowed (untagged content). On mismatch it sends a 400 and returns { ok: false }.
 */
async function resolveCatalogSubjectOrError(res, batchIds, subject) {
  const r = await validateBatchSubject(batchIds, subject);
  if (r.ok) return { ok: true, value: r.value };
  sendError(res, 400, "INVALID_SUBJECT", invalidSubjectMessage(r.allowed));
  return { ok: false };
}

const starterCodeSchema = z
  .object({
    python: z.string().optional(),
    javascript: z.string().optional(),
    java: z.string().optional(),
    cpp: z.string().optional(),
  })
  .optional();

function slugifyQuestionName(input) {
  const base = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `q-${Date.now()}`;
}

function paginate(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveStaffDisplayName(req) {
  const sub = String(req?.staff?.sub || "").trim();
  if (sub && mongoose.isValidObjectId(sub)) {
    const staffDoc = await Staff.findById(sub).select("name").lean();
    const name = String(staffDoc?.name || "").trim();
    if (name) return name;
  }
  return "";
}

function weekdayFromDateString(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!raw) return "";
  const [y, m, d] = raw.slice(0, 10).split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return "";
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { weekday: "long" });
}

async function fanoutTimetableSlotNotification(slot, action) {
  const batchId = String(slot?.batch_id || "").trim().toLowerCase();
  if (!batchId) return;
  const sectionId = String(slot?.section_id || "").trim().toLowerCase();
  const title = "Timetable updated";
  const body = `${slot.subject} on ${slot.day} (${slot.time}) by ${slot.teacher} was ${action}.`;
  const refId = `timetable-slot:${String(slot._id)}`;

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
  }));
  await Notification.insertMany(docs, { ordered: false });
}

async function fanoutMentorSlotNotification(slot) {
  const targetStudentIds = Array.isArray(slot?.target_student_ids)
    ? slot.target_student_ids.map((id) => String(id)).filter(Boolean)
    : [];
  const targetBatchIds = Array.isArray(slot?.target_batch_ids)
    ? slot.target_batch_ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean)
    : [];
  const targetSectionIds = Array.isArray(slot?.target_section_ids)
    ? slot.target_section_ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean)
    : [];

  let students = [];
  if (targetStudentIds.length > 0) {
    students = await Student.find({ _id: { $in: targetStudentIds }, role: "student" }).select("_id").lean();
  } else if (targetBatchIds.length > 0) {
    const filter = await studentsInBatchesFilterResolved(targetBatchIds, {
      sectionIds: targetSectionIds.length > 0 ? targetSectionIds : undefined,
    });
    students = await Student.find(filter).select("_id").lean();
  }

  if (!students.length) return;
  const title = "New mentor session published";
  const body = `${slot.mentor_name} mentor session on ${new Date(slot.date).toLocaleDateString()} at ${slot.time}.`;
  const refId = `mentor-slot:${String(slot._id)}`;
  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: refId,
  }));
  await Notification.insertMany(docs, { ordered: false });
}

async function notifyMentorPublishEmail(slot) {
  const mentorName = String(slot?.mentor_name || "").trim();
  if (!mentorName) return;

  const recipients = await Staff.find({
    role: { $in: ["mentor", "instructor"] },
    is_active: true,
    name: mentorName,
  })
    .select("email name role")
    .lean();
  if (!recipients.length) return;

  const batchLine =
    Array.isArray(slot.target_batch_ids) && slot.target_batch_ids.length
      ? slot.target_batch_ids.join(", ")
      : "N/A";
  const sectionLine =
    Array.isArray(slot.target_section_ids) && slot.target_section_ids.length
      ? slot.target_section_ids.join(", ")
      : "All sections";
  const audienceLine =
    Array.isArray(slot.target_student_ids) && slot.target_student_ids.length
      ? `${slot.target_student_ids.length} selected student(s)`
      : "All students in selected batch/sections";
  const sessionDate = slot.date ? new Date(slot.date) : null;
  const publishDate = slot.publish_date ? new Date(slot.publish_date) : null;

  for (const recipient of recipients) {
    if (!recipient.email) continue;
    const subject = `Mentor session published - ${mentorName}`;
    const htmlContent = `
      <div style="font-family:Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 12px">New mentor session published</h2>
        <p>Hello ${recipient.name || mentorName},</p>
        <p>A mentor session has been published with the following details:</p>
        <ul>
          <li><strong>Mentor:</strong> ${mentorName}</li>
          <li><strong>Session date:</strong> ${sessionDate ? sessionDate.toLocaleDateString() : "N/A"}</li>
          <li><strong>Session time:</strong> ${slot.time || "N/A"}</li>
          <li><strong>Publish date:</strong> ${publishDate ? publishDate.toLocaleString() : "Immediate"}</li>
          <li><strong>Batch:</strong> ${batchLine}</li>
          <li><strong>Sections:</strong> ${sectionLine}</li>
          <li><strong>Audience:</strong> ${audienceLine}</li>
          <li><strong>Meet link:</strong> ${slot.meet_link || "Not set"}</li>
        </ul>
        <p>Regards,<br/>CodeMasti Admin</p>
      </div>
    `.trim();
    const textContent = [
      `Hello ${recipient.name || mentorName},`,
      "A mentor session has been published.",
      `Mentor: ${mentorName}`,
      `Session date: ${sessionDate ? sessionDate.toLocaleDateString() : "N/A"}`,
      `Session time: ${slot.time || "N/A"}`,
      `Publish date: ${publishDate ? publishDate.toLocaleString() : "Immediate"}`,
      `Batch: ${batchLine}`,
      `Sections: ${sectionLine}`,
      `Audience: ${audienceLine}`,
      `Meet link: ${slot.meet_link || "Not set"}`,
    ].join("\n");
    await sendSimpleEmail({ toEmail: recipient.email, subject, htmlContent, textContent });
  }
}

/** —— Assignments —— */
async function listAssignments(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const subject = String(req.query.subject || "").trim();
  const batchRaw = req.query.batch_id;
  const batchNorm =
    batchRaw !== undefined && String(batchRaw).trim() !== ""
      ? String(batchRaw).trim().toLowerCase()
      : null;

  const clauses = [];
  if (subject) clauses.push({ subject });
  const batchClause = batchNorm ? assignmentMatchesCatalogBatchId(batchNorm) : null;
  if (batchClause) clauses.push(batchClause);

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    if (batchNorm && !instructorBatches.includes(batchNorm)) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    const ors = instructorBatches.map((bid) => assignmentMatchesCatalogBatchId(bid)).filter(Boolean);
    if (ors.length) clauses.push({ $or: ors });
  }

  const filter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };

  const [items, total] = await Promise.all([
    Assignment.find(filter).sort({ release_date: -1 }).skip(skip).limit(limit).lean(),
    Assignment.countDocuments(filter),
  ]);
  return sendSuccess(
    res,
    items.map((a) => ({ id: String(a._id), ...a })),
    "",
    { page, limit, total }
  );
}

async function getAssignment(req, res) {
  const doc = await Assignment.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(doc, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  return sendSuccess(res, { id: String(doc._id), ...doc });
}

async function createAssignment(req, res) {
  const schema = z
    .object({
      batch_ids: z.array(z.string().min(1).trim()).optional().default([]),
      batch_id: z.string().min(1).trim().optional(), // legacy support for single batch_id
      title: z.string().min(1).trim().optional().default(""),
      section_id: z.string().trim().optional().default(""),
      subject: z.string().min(1).trim(),
      module: z.string().min(1).trim(),
      assignment_type: z.enum(["quiz", "coding", "written", "project", "other"]).optional().default("written"),
      programming_language: z.enum(["python", "javascript"]).optional().default("python"),
      release_date: z.coerce.date(),
      deadline_date: z.coerce.date(),
      question_count: z.number().int().min(0).max(200).optional().default(0),
      resource_url: z.string().trim().optional().default(""),
      resource_size: z.string().trim().optional().default(""),
    })
    .refine((d) => d.deadline_date >= d.release_date, {
      message: "Deadline must be on or after the publish (go live) time.",
      path: ["deadline_date"],
    });
  const body = schema.parse(req.body);
  
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendError(res, 403, "FORBIDDEN", "No batches assigned to your instructor profile");
    }
  }

  // Support both batch_ids (array) and batch_id (legacy single)
  let batchIds = body.batch_ids && body.batch_ids.length > 0 ? body.batch_ids : [];
  if (!batchIds.length && body.batch_id) {
    batchIds = [body.batch_id];
  }
  if (!batchIds.length) {
    return sendError(res, 400, "BATCH_REQUIRED", "At least one batch must be selected.");
  }

  if (instructorBatches !== null) {
    const allow = new Set(instructorBatches);
    for (const batchId of batchIds) {
      const norm = String(batchId || "").trim().toLowerCase();
      if (!allow.has(norm)) {
        return sendError(res, 403, "FORBIDDEN", "You can only create assignments for your assigned batches");
      }
    }
  }

  const subjCheck = await resolveCatalogSubjectOrError(res, batchIds, body.subject);
  if (!subjCheck.ok) return;
  body.subject = subjCheck.value;

  // Create one assignment record per batch
  const createdAssignments = [];
  for (const batchId of batchIds) {
    const normBatch = batchId.toLowerCase().trim();
    const created = await Assignment.create({
      batch_id: normBatch,
      batch_ids: [normBatch],
      section_id: body.section_id || "",
      title: body.title || "",
      subject: body.subject,
      module: body.module,
      assignment_type: body.assignment_type,
      programming_language: body.programming_language,
      release_date: body.release_date,
      deadline_date: body.deadline_date,
      resource_url: body.resource_url || "",
      resource_size: body.resource_size || "",
    });

    if (body.question_count > 0) {
      const placeholders = Array.from({ length: body.question_count }, (_, idx) => {
        const n = idx + 1;
        const title = `Question ${n}`;
        return {
          assignment_id: created._id,
          name: slugifyQuestionName(`question-${n}`),
          title,
          description: "Add question description.",
          difficulty: "easy",
          xp: 10,
          topics: [],
          requirements: [],
          input_format: "",
          output_format: "",
          constraints: [],
          examples: [],
          time_limit: "1s",
          memory_limit: "128MB",
          execution_mode: "full_program",
          starter_code: {},
          hidden_tests: [],
          question_image_url: "",
          quiz_options: [],
        };
      });
      await AssignmentQuestion.insertMany(placeholders);
    }

    try {
      await notifyAssignmentReleasedIfEligible(created.toObject());
    } catch (e) {
      console.warn("[ASSIGNMENT_NOTIFY_FANOUT]", e?.message || e);
    }

    createdAssignments.push({
      id: String(created._id),
      ...created.toObject(),
      question_count: body.question_count,
    });
  }

  // Return first assignment or success message with count
  return sendSuccess(
    res,
    {
      assignments: createdAssignments,
      count: createdAssignments.length,
      message: `Created assignment for ${createdAssignments.length} batch${createdAssignments.length !== 1 ? "es" : ""}`,
    },
    "Created"
  );
}

async function updateAssignment(req, res) {
  const schema = z.object({
    batch_ids: z.array(z.string().min(1).trim()).optional(),
    batch_id: z.string().trim().optional(),
    title: z.string().trim().optional(),
    section_id: z.string().trim().optional(),
    subject: z.string().min(1).trim().optional(),
    module: z.string().min(1).trim().optional(),
    assignment_type: z.enum(["quiz", "coding", "written", "project", "other"]).optional(),
    programming_language: z.enum(["python", "javascript"]).optional(),
    release_date: z.coerce.date().optional(),
    deadline_date: z.coerce.date().optional(),
    resource_url: z.string().trim().optional(),
    resource_size: z.string().trim().optional(),
  });
  const body = schema.parse(req.body);
  const doc = await Assignment.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Assignment not found");

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendError(res, 403, "FORBIDDEN", "No batches assigned to your instructor profile");
    }
    if (!assignmentDocTouchesAllowedBatches(doc, instructorBatches)) {
      return sendError(res, 403, "FORBIDDEN", "You can only update assignments for your assigned batches");
    }
    if (body.batch_ids !== undefined && body.batch_ids.length > 0) {
      const allow = new Set(instructorBatches);
      for (const x of body.batch_ids) {
        const norm = String(x || "").trim().toLowerCase();
        if (!allow.has(norm)) {
          return sendError(res, 403, "FORBIDDEN", "You can only assign to your assigned batches");
        }
      }
    } else if (body.batch_id !== undefined && body.batch_id) {
      const norm = String(body.batch_id).trim().toLowerCase();
      if (!instructorBatches.includes(norm)) {
        return sendError(res, 403, "FORBIDDEN", "You can only assign to your assigned batches");
      }
    }
  }
  
  // Handle batch_ids array (for future multi-batch support) — keep batch_id + batch_ids in sync
  if (body.batch_ids !== undefined && body.batch_ids.length > 0) {
    const normalized = body.batch_ids.map((x) => String(x || "").toLowerCase().trim()).filter(Boolean);
    doc.batch_ids = normalized;
    doc.batch_id = normalized[0] || "";
  } else if (body.batch_id !== undefined) {
    const one = body.batch_id ? body.batch_id.toLowerCase().trim() : "";
    doc.batch_id = one;
    doc.batch_ids = one ? [one] : [];
  }
  
  if (body.subject !== undefined) {
    const subjCheck = await resolveCatalogSubjectOrError(res, doc.batch_ids, body.subject);
    if (!subjCheck.ok) return;
    body.subject = subjCheck.value;
  }

  const { batch_id: _b, batch_ids: _bs, ...rest } = body;
  Object.assign(doc, rest);

  const rel = doc.release_date;
  const due = doc.deadline_date;
  if (rel && due && new Date(due).getTime() < new Date(rel).getTime()) {
    return sendError(
      res,
      400,
      "VALIDATION",
      "Deadline must be on or after the publish (go live) time."
    );
  }
  await doc.save();
  try {
    await notifyAssignmentReleasedIfEligible(doc.toObject());
  } catch (e) {
    console.warn("[ASSIGNMENT_NOTIFY_FANOUT_UPDATE]", e?.message || e);
  }
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
}

async function deleteAssignment(req, res) {
  const id = req.params.id;
  const a = await Assignment.findById(id);
  if (!a) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(a, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "You can only delete assignments for your assigned batches");
  }
  const qRows = await AssignmentQuestion.find({ assignment_id: id }).select("_id").lean();
  const qIds = qRows.map((r) => r._id);
  await AssignmentSubmission.deleteMany({ question_id: { $in: qIds } });
  await AssignmentQuestion.deleteMany({ assignment_id: id });
  await Assignment.deleteOne({ _id: id });
  return sendSuccess(res, { id }, "Deleted");
}

/** —— Assignment questions —— */
async function listAssignmentQuestions(req, res) {
  const { assignmentId } = req.params;
  const a = await Assignment.findById(assignmentId).lean();
  if (!a) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(a, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  const items = await AssignmentQuestion.find({ assignment_id: assignmentId }).sort({ name: 1 }).lean();
  return sendSuccess(
    res,
    items.map((q) => ({
      id: String(q._id),
      assignment_id: String(q.assignment_id),
      name: q.name,
      title: q.title,
      difficulty: q.difficulty,
      xp: q.xp,
      topics: q.topics,
    }))
  );
}

const questionBodySchema = z.object({
  name: z.string().trim().optional(),
  title: z.string().min(1).trim(),
  description: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  xp: z.number().int().min(0).optional(),
  topics: z.array(z.string()).optional(),
  requirements: z.array(z.string()).optional(),
  input_format: z.string().optional(),
  output_format: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  examples: z.array(z.any()).optional(),
  time_limit: z.string().optional(),
  memory_limit: z.string().optional(),
  execution_mode: z.enum(["full_program", "function_only"]).optional(),
  starter_code: starterCodeSchema,
  hidden_tests: z.array(z.any()).max(20, "Maximum 20 hidden test cases allowed.").optional(),
  question_image_url: z.string().trim().optional(),
  code: z.string().optional(),
  code_language: z.string().trim().optional(),
  quiz_options: z
    .array(
      z.object({
        text: z.string().trim().optional().default(""),
        image_url: z.string().trim().optional().default(""),
        is_correct: z.boolean().optional().default(false),
      })
    )
    .optional(),
});

async function createAssignmentQuestion(req, res) {
  const { assignmentId } = req.params;
  const a = await Assignment.findById(assignmentId);
  if (!a) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(a, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  const body = questionBodySchema.parse(req.body);
  const computedName = slugifyQuestionName(body.name || body.title);
  const created = await AssignmentQuestion.create({
    assignment_id: assignmentId,
    ...body,
    name: computedName,
    starter_code: body.starter_code || {},
    hidden_tests: body.hidden_tests || [],
  });
  return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
}

async function getAssignmentQuestion(req, res) {
  const { assignmentId, questionId } = req.params;
  const a = await Assignment.findById(assignmentId).lean();
  if (!a) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(a, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  const q = await AssignmentQuestion.findOne({ _id: questionId, assignment_id: assignmentId }).lean();
  if (!q) return sendError(res, 404, "NOT_FOUND", "Question not found");
  return sendSuccess(res, { id: String(q._id), ...q, assignment_id: String(q.assignment_id) });
}

async function updateAssignmentQuestion(req, res) {
  const { assignmentId, questionId } = req.params;
  const body = questionBodySchema.partial().parse(req.body);
  const a = await Assignment.findById(assignmentId).lean();
  if (!a) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(a, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  const q = await AssignmentQuestion.findOne({ _id: questionId, assignment_id: assignmentId });
  if (!q) return sendError(res, 404, "NOT_FOUND", "Question not found");
  const { starter_code: starterPatch, ...rest } = body;
  Object.assign(q, rest);
  if (starterPatch !== undefined) {
    q.starter_code = starterPatch && typeof starterPatch === "object" ? starterPatch : {};
  }
  await q.save();
  return sendSuccess(res, { id: String(q._id), ...q.toObject() }, "Updated");
}

async function deleteAssignmentQuestion(req, res) {
  const { assignmentId, questionId } = req.params;
  const a = await Assignment.findById(assignmentId).lean();
  if (!a) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(a, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  const q = await AssignmentQuestion.findOne({ _id: questionId, assignment_id: assignmentId });
  if (!q) return sendError(res, 404, "NOT_FOUND", "Question not found");
  await AssignmentSubmission.deleteMany({ question_id: questionId });
  await AssignmentQuestion.deleteOne({ _id: questionId });
  return sendSuccess(res, { id: questionId }, "Deleted");
}

/** —— Arena —— */
async function listArenaQuestions(req, res) {
  const { page, limit, skip } = paginate(req);
  const batch_id = String(req.query.batch_id || "").trim().toLowerCase();
  
  // Filter by batch_id (either old format batch_id field or new format in batch_ids array)
  const filter = batch_id
    ? {
        $or: [
          { batch_id }, // Old format: single batch_id
          { batch_ids: { $in: [batch_id] } }, // New format: array of batch_ids
        ],
      }
    : {};

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  let mergedFilter = filter;
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(
        res,
        [],
        "",
        { page, limit, total: 0 }
      );
    }
    if (batch_id && !instructorBatches.includes(batch_id)) {
      return sendSuccess(
        res,
        [],
        "",
        { page, limit, total: 0 }
      );
    }
    const scopeOr = {
      $or: [{ batch_id: { $in: instructorBatches } }, { batch_ids: { $in: instructorBatches } }],
    };
    mergedFilter = Object.keys(filter).length ? { $and: [filter, scopeOr] } : scopeOr;
  }

  const [items, total] = await Promise.all([
    ArenaQuestion.find(mergedFilter).sort({ number: 1 }).skip(skip).limit(limit).lean(),
    ArenaQuestion.countDocuments(mergedFilter),
  ]);
  return sendSuccess(
    res,
    items.map((q) => ({ id: String(q._id), ...q })),
    "",
    { page, limit, total }
  );
}

const arenaBodySchema = z.object({
  batch_id: z.string().trim().toLowerCase().min(1).optional(),
  batch_ids: z.array(z.string()).transform(arr => arr.map(s => String(s).trim().toLowerCase())).optional(),
  number: z.number().int().optional(),
  question_type: z.enum(["quiz", "coding", "written"]).optional().default("coding"),
  title: z.string().min(1).trim(),
  subject: z.string().optional(),
  topic: z.string().optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  description: z.string().trim().min(1),
  requirements: z.array(z.string()).optional(),
  input_format: z.string().optional(),
  output_format: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  examples: z.array(z.any()).optional(),
  time_limit: z.string().optional(),
  memory_limit: z.string().optional(),
  starter_code: starterCodeSchema,
  hidden_tests: z.array(z.any()).optional(),
  question_image_url: z.string().trim().nullable().optional(),
  quiz_options: z
    .array(
      z.object({
        text: z.string().trim().optional().default(""),
        image_url: z.string().trim().nullable().optional().default(null),
        is_correct: z.boolean().optional().default(false),
      })
    )
    .optional(),
  xp: z.number().int().optional(),
  acceptance_rate: z.number().optional(),
  is_disabled: z.boolean().optional(),
});

async function getArenaQuestion(req, res) {
  const doc = await ArenaQuestion.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Arena question not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !arenaDocTouchesAllowedBatches(doc, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Arena question is not for your assigned batches");
  }
  return sendSuccess(res, { id: String(doc._id), ...doc });
}

async function createArenaQuestion(req, res) {
  try {
    const body = arenaBodySchema.parse(req.body);
    
    // Validate batch selection: either batch_id or batch_ids required
    const hasBatchId = body.batch_id && String(body.batch_id).trim();
    const hasBatchIds = body.batch_ids && Array.isArray(body.batch_ids) && body.batch_ids.length > 0;
    
    if (!hasBatchId && !hasBatchIds) {
      return sendError(res, 400, "VALIDATION_ERROR", "batch_id or batch_ids is required");
    }

    const instructorBatches = await getInstructorAssignedBatchIds(req);
    if (instructorBatches !== null) {
      if (!instructorBatches.length) {
        return sendError(res, 403, "FORBIDDEN", "No batches assigned to your instructor profile");
      }
      const targets = hasBatchIds ? body.batch_ids : [body.batch_id];
      const allow = new Set(instructorBatches);
      for (const t of targets) {
        if (!allow.has(String(t || "").trim().toLowerCase())) {
          return sendError(res, 403, "FORBIDDEN", "You can only create arena content for your assigned batches");
        }
      }
    }

    const arenaBatchIds = hasBatchIds ? body.batch_ids : [body.batch_id];
    const subjCheck = await resolveCatalogSubjectOrError(res, arenaBatchIds, body.subject);
    if (!subjCheck.ok) return;
    if (subjCheck.value !== undefined) body.subject = subjCheck.value;

    const created = await ArenaQuestion.create({
      ...body,
      starter_code: body.starter_code || {},
      hidden_tests: body.hidden_tests || [],
    });
    return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
  } catch (error) {
    if (error?.errors && Array.isArray(error.errors)) {
      const messages = error.errors.map(e => {
        const path = Array.isArray(e.path) ? e.path.join('.') : String(e.path || 'field');
        return `${path}: ${e.message}`;
      }).join('; ');
      return sendError(res, 400, "VALIDATION_ERROR", messages);
    }
    throw error;
  }
}

async function updateArenaQuestion(req, res) {
  try {
    const body = arenaBodySchema.partial().parse(req.body);
    const doc = await ArenaQuestion.findById(req.params.id);
    if (!doc) return sendError(res, 404, "NOT_FOUND", "Arena question not found");
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    if (instructorBatches !== null) {
      if (!instructorBatches.length) {
        return sendError(res, 403, "FORBIDDEN", "No batches assigned to your instructor profile");
      }
      if (!arenaDocTouchesAllowedBatches(doc, instructorBatches)) {
        return sendError(res, 403, "FORBIDDEN", "Arena question is not for your assigned batches");
      }
      if (body.batch_id !== undefined && String(body.batch_id || "").trim()) {
        const nb = String(body.batch_id).trim().toLowerCase();
        if (!instructorBatches.includes(nb)) {
          return sendError(res, 403, "FORBIDDEN", "You can only assign to your assigned batches");
        }
      }
      if (body.batch_ids !== undefined && Array.isArray(body.batch_ids) && body.batch_ids.length > 0) {
        const allow = new Set(instructorBatches);
        for (const x of body.batch_ids) {
          if (!allow.has(String(x || "").trim().toLowerCase())) {
            return sendError(res, 403, "FORBIDDEN", "You can only assign to your assigned batches");
          }
        }
      }
    }
    if (body.subject !== undefined) {
      const effBatchIds =
        body.batch_ids && body.batch_ids.length
          ? body.batch_ids
          : body.batch_id
            ? [body.batch_id]
            : doc.batch_ids && doc.batch_ids.length
              ? doc.batch_ids
              : [doc.batch_id];
      const subjCheck = await resolveCatalogSubjectOrError(res, effBatchIds, body.subject);
      if (!subjCheck.ok) return;
      body.subject = subjCheck.value;
    }
    Object.assign(doc, body);
    await doc.save();
    return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
  } catch (error) {
    if (error?.errors && Array.isArray(error.errors)) {
      const messages = error.errors.map(e => {
        const path = Array.isArray(e.path) ? e.path.join('.') : String(e.path || 'field');
        return `${path}: ${e.message}`;
      }).join('; ');
      return sendError(res, 400, "VALIDATION_ERROR", messages);
    }
    throw error;
  }
}

async function deleteArenaQuestion(req, res) {
  const id = req.params.id;
  const doc = await ArenaQuestion.findById(id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Arena question not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !arenaDocTouchesAllowedBatches(doc, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Arena question is not for your assigned batches");
  }
  await ArenaSubmission.deleteMany({ question_id: id });
  await ArenaQuestion.deleteOne({ _id: id });
  return sendSuccess(res, { id }, "Deleted");
}

/** —— Live classes —— */
async function listLiveClasses(req, res) {
  const { page, limit, skip } = paginate(req);
  const batch_id_q = String(req.query.batch_id || "").trim().toLowerCase();
  const filter = {};
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    if (batch_id_q) {
      if (!instructorBatches.includes(batch_id_q)) {
        return sendSuccess(res, [], "", { page, limit, total: 0 });
      }
      filter.batch_id = batch_id_q;
    } else {
      filter.batch_id = { $in: instructorBatches };
    }
  } else if (batch_id_q) {
    filter.batch_id = batch_id_q;
  }
  const [items, total] = await Promise.all([
    LiveClass.find(filter).sort({ date: 1, start_time: 1 }).skip(skip).limit(limit).lean(),
    LiveClass.countDocuments(filter),
  ]);
  return sendSuccess(
    res,
    items.map((c) => ({ id: String(c._id), ...c })),
    "",
    { page, limit, total }
  );
}

async function getLiveClass(req, res) {
  const doc = await LiveClass.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Live class not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    const bid = String(doc.batch_id || "").trim().toLowerCase();
    if (!bid || !instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "Live class is not for your assigned batches");
    }
  }
  return sendSuccess(res, { id: String(doc._id), ...doc });
}

async function createLiveClass(req, res) {
  const schema = z.object({
    subject: z.string().min(1).trim(),
    topic: z.string().min(1).trim(),
    instructor: z.string().min(1).trim(),
    batch_id: z.string().min(1).trim(),
    date: z.string().min(10),
    start_time: z.string().min(1),
    end_time: z.string().min(1),
    meet_link: z.string().min(1).trim(),
    recording_link: z.string().optional().default(""),
  });
  const body = schema.parse(req.body);
  if (req.staff?.role === "instructor") {
    const ownName = await resolveStaffDisplayName(req);
    if (!ownName) return sendError(res, 403, "FORBIDDEN", "Instructor profile is incomplete");
    body.instructor = ownName;
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    const bid = String(body.batch_id || "").trim().toLowerCase();
    if (!instructorBatches?.length) {
      return sendError(res, 403, "FORBIDDEN", "No batches assigned to your instructor profile");
    }
    if (!instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "Live class must be in one of your assigned batches");
    }
  }
  const subjCheck = await resolveCatalogSubjectOrError(res, [body.batch_id], body.subject);
  if (!subjCheck.ok) return;
  body.subject = subjCheck.value;
  const created = await LiveClass.create(body);
  return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
}

async function updateLiveClass(req, res) {
  const schema = z.object({
    subject: z.string().min(1).trim().optional(),
    topic: z.string().min(1).trim().optional(),
    instructor: z.string().min(1).trim().optional(),
    batch_id: z.string().min(1).trim().optional(),
    date: z.string().min(10).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    meet_link: z.string().optional(),
    recording_link: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const doc = await LiveClass.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Live class not found");
  if (req.staff?.role === "instructor") {
    const ownName = await resolveStaffDisplayName(req);
    if (!ownName) return sendError(res, 403, "FORBIDDEN", "Instructor profile is incomplete");
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    const curBid = String(doc.batch_id || "").trim().toLowerCase();
    if (!instructorBatches?.length || !curBid || !instructorBatches.includes(curBid)) {
      return sendError(res, 403, "FORBIDDEN", "You can only update classes in your assigned batches");
    }
    if (body.batch_id !== undefined && body.batch_id) {
      const nb = String(body.batch_id).trim().toLowerCase();
      if (!instructorBatches.includes(nb)) {
        return sendError(res, 403, "FORBIDDEN", "You can only move classes within your assigned batches");
      }
    }
    body.instructor = ownName;
  }
  if (body.subject !== undefined) {
    const subjCheck = await resolveCatalogSubjectOrError(res, [body.batch_id || doc.batch_id], body.subject);
    if (!subjCheck.ok) return;
    body.subject = subjCheck.value;
  }
  Object.assign(doc, body);
  await doc.save();
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
}

async function deleteLiveClass(req, res) {
  const doc = await LiveClass.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Live class not found");
  if (req.staff?.role === "instructor") {
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    const bid = String(doc.batch_id || "").trim().toLowerCase();
    if (!instructorBatches?.length || !bid || !instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "You can only delete classes in your assigned batches");
    }
  }
  const r = await LiveClass.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Live class not found");
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

/** —— Timetable slots —— */
async function listTimetableSlots(req, res) {
  const { page, limit, skip } = paginate(req);
  const batch_id = String(req.query.batch_id || "").trim().toLowerCase();
  const section_id = String(req.query.section_id || "").trim().toLowerCase();
  const month = Number(req.query.month || 0);
  let year = Number(req.query.year || 0);
  // Month filter uses class_date (YYYY-MM-DD). If month is set without a valid year, default to current year.
  if (month >= 1 && month <= 12 && !(year >= 1900 && year <= 9999)) {
    year = new Date().getFullYear();
  }
  const filter = {};
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    if (batch_id) {
      if (!instructorBatches.includes(batch_id)) {
        return sendSuccess(res, [], "", { page, limit, total: 0 });
      }
      filter.batch_id = batch_id;
    } else {
      filter.batch_id = { $in: instructorBatches };
    }
  } else if (batch_id) {
    filter.batch_id = batch_id;
  }
  if (batch_id && section_id) {
    filter.$or = [{ section_id: "" }, { section_id: { $exists: false } }, { section_id: section_id }];
  }
  if (year >= 1900) {
    if (month >= 1 && month <= 12) {
      const mm = String(month).padStart(2, "0");
      filter.class_date = { $regex: `^${year}-${mm}-` };
    } else {
      filter.class_date = { $regex: `^${year}-` };
    }
  }
  const [items, total] = await Promise.all([
    TimetableSlot.find(filter).sort({ class_date: 1, day: 1, time: 1 }).skip(skip).limit(limit).lean(),
    TimetableSlot.countDocuments(filter),
  ]);
  return sendSuccess(
    res,
    items.map((s) => ({ id: String(s._id), ...s })),
    "",
    { page, limit, total }
  );
}

/** Week/month calendar: date-range slots. Instructors see only their own classes in assigned batches. */
async function listTimetableSchedule(req, res) {
  const schema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  const query = schema.parse(req.query);

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const now = new Date();
  const fromDefault = new Date(now);
  fromDefault.setDate(fromDefault.getDate() - 14);
  const toDefault = new Date(now);
  toDefault.setDate(toDefault.getDate() + 90);
  const from = query.from || fmt(fromDefault);
  const to = query.to || fmt(toDefault);

  const filter = { class_date: { $gte: from, $lte: to } };
  const instructorBatches = await getInstructorAssignedBatchIds(req);

  if (req.staff?.role === "instructor") {
    const ownName = await resolveStaffDisplayName(req);
    if (!ownName) return sendSuccess(res, []);
    if (!instructorBatches?.length) return sendSuccess(res, []);
    filter.batch_id = { $in: instructorBatches };
    filter.teacher = { $regex: new RegExp(`^${escapeRegex(ownName)}$`, "i") };
  } else if (instructorBatches !== null) {
    if (!instructorBatches.length) return sendSuccess(res, []);
    filter.batch_id = { $in: instructorBatches };
  }

  const slots = await TimetableSlot.find(filter).sort({ class_date: 1, time: 1 }).lean();
  const data = slots.map((slot) => ({
    id: String(slot._id),
    batch_id: slot.batch_id || "",
    section_id: slot.section_id || "",
    day: slot.day,
    time: slot.time,
    subject: slot.subject,
    topic: slot.topic || "",
    teacher: slot.teacher,
    class_date: slot.class_date || "",
    meet_link: slot.meet_link || "",
    recording_link: slot.recording_link || "",
    notes_link: slot.notes_link || "",
    is_taken: Boolean(slot.is_taken),
  }));
  return sendSuccess(res, data);
}

async function getTimetableSlot(req, res) {
  const doc = await TimetableSlot.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Slot not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    const bid = String(doc.batch_id || "").trim().toLowerCase();
    if (!instructorBatches.length || !bid || !instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "Timetable slot is not for your assigned batches");
    }
  }
  return sendSuccess(res, { id: String(doc._id), ...doc });
}

async function createTimetableSlot(req, res) {
  const schema = z.object({
    batch_id: z.string().min(1).trim(),
    section_id: z.string().trim().optional().default(""),
    class_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().min(1).trim(),
    subject: z.string().min(1).trim(),
    topic: z.string().optional().default(""),
    teacher: z.string().min(1).trim(),
    meet_link: z.string().url().min(1).trim(),
    recording_link: z.string().optional().default(""),
    notes_link: z.string().optional().default(""),
    is_taken: z.boolean().optional().default(false),
    /** When true, also email students and instructors for recording/notes uploads; in-app notices always go out. */
    notify_resource_by_email: z.boolean().optional().default(false),
  });
  const body = schema.parse(req.body);
  const notifyResourceByEmail = body.notify_resource_by_email === true;
  if (req.staff?.role === "instructor") {
    const ownName = await resolveStaffDisplayName(req);
    if (!ownName) return sendError(res, 403, "FORBIDDEN", "Instructor profile is incomplete");
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    const bid = String(body.batch_id || "").trim().toLowerCase();
    if (!instructorBatches?.length || !instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "Timetable slot must be in one of your assigned batches");
    }
    body.teacher = ownName;
  }
  const subjCheck = await resolveCatalogSubjectOrError(res, [body.batch_id], body.subject);
  if (!subjCheck.ok) return;
  body.subject = subjCheck.value;
  const derivedDay = weekdayFromDateString(body.class_date);
  if (!derivedDay) return sendError(res, 400, "VALIDATION_ERROR", "Invalid class_date");

  const docs = [
    {
    batch_id: body.batch_id.toLowerCase().trim(),
    section_id: (body.section_id || "").toLowerCase().trim(),
    day: derivedDay,
    class_date: body.class_date.trim(),
    time: body.time.trim(),
    subject: body.subject.trim(),
    topic: String(body.topic || "").trim(),
    teacher: body.teacher.trim(),
    meet_link: body.meet_link.trim(),
    recording_link: String(body.recording_link || "").trim(),
    notes_link: String(body.notes_link || "").trim(),
    is_taken: Boolean(body.is_taken),
    },
  ];

  const created = await TimetableSlot.insertMany(docs, { ordered: false });
  for (const row of created) {
    await fanoutTimetableSlotNotification(row.toObject(), "created");
    const slot = row.toObject();
    if (String(slot.recording_link || "").trim()) {
      const whenText = fmtWhenLocal(slot.class_date, slot.time);
      await notifyStudentsForSlot({
        slot,
        type: "recording_uploaded",
        title: "Recording uploaded",
        body: `Recording is available for ${slot.subject} (${whenText}).`,
        deep_link: "/lectures",
        dedupePrefix: "recordingUploaded",
        email: notifyResourceByEmail
          ? ({ student }) => buildResourceUploadedEmail({ studentName: student?.name, slot, kind: "recording" })
          : null,
      });
    }
    if (String(slot.notes_link || "").trim()) {
      const whenText = fmtWhenLocal(slot.class_date, slot.time);
      await notifyStudentsForSlot({
        slot,
        type: "notes_uploaded",
        title: "Notes uploaded",
        body: `Notes are available for ${slot.subject} (${whenText}).`,
        deep_link: "/lectures",
        dedupePrefix: "notesUploaded",
        email: notifyResourceByEmail
          ? ({ student }) => buildResourceUploadedEmail({ studentName: student?.name, slot, kind: "notes" })
          : null,
      });
    }
  }
  const data = created.map((r) => ({ id: String(r._id), ...r.toObject() }));
  return sendSuccess(res, data, data.length === 1 ? "Created" : `Created ${data.length} slots`);
}

async function updateTimetableSlot(req, res) {
  const schema = z.object({
    batch_id: z.string().min(1).trim().optional(),
    section_id: z.string().trim().optional(),
    class_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    time: z.string().optional(),
    subject: z.string().optional(),
    topic: z.string().optional(),
    teacher: z.string().optional(),
    meet_link: z.string().url().optional(),
    recording_link: z.string().optional(),
    notes_link: z.string().optional(),
    is_taken: z.boolean().optional(),
    notify_resource_by_email: z.boolean().optional().default(false),
  });
  const body = schema.parse(req.body);
  const notifyResourceByEmail = body.notify_resource_by_email === true;
  const doc = await TimetableSlot.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Slot not found");
  const prevClassDate = String(doc.class_date || "").trim();
  const prevTime = String(doc.time || "").trim();
  const prevRecording = String(doc.recording_link || "").trim();
  const prevNotes = String(doc.notes_link || "").trim();
  if (req.staff?.role === "instructor") {
    const ownName = await resolveStaffDisplayName(req);
    if (!ownName) return sendError(res, 403, "FORBIDDEN", "Instructor profile is incomplete");
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    const curBid = String(doc.batch_id || "").trim().toLowerCase();
    if (!instructorBatches?.length || !curBid || !instructorBatches.includes(curBid)) {
      return sendError(res, 403, "FORBIDDEN", "You can only update slots in your assigned batches");
    }
    if (body.batch_id !== undefined && body.batch_id) {
      const nb = String(body.batch_id).trim().toLowerCase();
      if (!instructorBatches.includes(nb)) {
        return sendError(res, 403, "FORBIDDEN", "You can only move slots within your assigned batches");
      }
    }
    body.teacher = ownName;
  }
  if (body.batch_id !== undefined) doc.batch_id = body.batch_id.toLowerCase().trim();
  if (body.section_id !== undefined) doc.section_id = (body.section_id || "").toLowerCase().trim();
  if (body.class_date !== undefined) {
    doc.class_date = body.class_date.trim();
    const d = weekdayFromDateString(doc.class_date);
    if (!d) return sendError(res, 400, "VALIDATION_ERROR", "Invalid class_date");
    doc.day = d;
  }
  if (body.subject !== undefined) {
    const subjCheck = await resolveCatalogSubjectOrError(res, [doc.batch_id], body.subject);
    if (!subjCheck.ok) return;
    body.subject = subjCheck.value;
  }
  const { notify_resource_by_email: _notifyEmail, batch_id: _b, section_id: _s, ...rest } = body;
  Object.assign(doc, rest);
  if (body.time !== undefined) doc.time = body.time.trim();
  if (body.subject !== undefined) doc.subject = body.subject.trim();
  if (body.topic !== undefined) doc.topic = String(body.topic || "").trim();
  if (body.teacher !== undefined) doc.teacher = body.teacher.trim();
  if (body.meet_link !== undefined) doc.meet_link = body.meet_link.trim();
  if (body.recording_link !== undefined) doc.recording_link = String(body.recording_link || "").trim();
  if (body.notes_link !== undefined) doc.notes_link = String(body.notes_link || "").trim();
  if (body.is_taken !== undefined) doc.is_taken = Boolean(body.is_taken);

  // If the scheduled time changes, allow reminders to fire again for the new start time.
  const nextClassDate = String(doc.class_date || "").trim();
  const nextTime = String(doc.time || "").trim();
  if (prevClassDate !== nextClassDate || prevTime !== nextTime) {
    doc.student_reminder_10m_sent_at = null;
    doc.instructor_reminder_10m_sent_at = null;
    doc.meet_link_missing_10m_alert_sent_at = null;
  }

  await doc.save();
  await fanoutTimetableSlotNotification(doc.toObject(), "updated");

  // Student reminders: fire only when link becomes available for the first time.
  const nextRecording = String(doc.recording_link || "").trim();
  const nextNotes = String(doc.notes_link || "").trim();
  const slot = doc.toObject();
  const whenText = fmtWhenLocal(slot.class_date, slot.time);

  if (!prevRecording && nextRecording) {
    await notifyStudentsForSlot({
      slot,
      type: "recording_uploaded",
      title: "Recording uploaded",
      body: `Recording is available for ${slot.subject} (${whenText}).`,
      deep_link: "/lectures",
      dedupePrefix: "recordingUploaded",
      email: notifyResourceByEmail
        ? ({ student }) => buildResourceUploadedEmail({ studentName: student?.name, slot, kind: "recording" })
        : null,
    });

    await notifyInstructorsForSlot({
      slot,
      event_type: "timetable_recording_uploaded",
      title: "Recording uploaded",
      message: `Recording link added for ${slot.subject} (${whenText}).`,
      emailBuilder: notifyResourceByEmail
        ? ({ staff }) => buildInstructorResourceEmail({ staffName: staff?.name, slot, kind: "recording" })
        : undefined,
    });
  }
  if (!prevNotes && nextNotes) {
    await notifyStudentsForSlot({
      slot,
      type: "notes_uploaded",
      title: "Notes uploaded",
      body: `Notes are available for ${slot.subject} (${whenText}).`,
      deep_link: "/lectures",
      dedupePrefix: "notesUploaded",
      email: notifyResourceByEmail
        ? ({ student }) => buildResourceUploadedEmail({ studentName: student?.name, slot, kind: "notes" })
        : null,
    });

    await notifyInstructorsForSlot({
      slot,
      event_type: "timetable_notes_uploaded",
      title: "Notes uploaded",
      message: `Notes link added for ${slot.subject} (${whenText}).`,
      emailBuilder: notifyResourceByEmail
        ? ({ staff }) => buildInstructorResourceEmail({ staffName: staff?.name, slot, kind: "notes" })
        : undefined,
    });
  }

  return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
}

async function deleteTimetableSlot(req, res) {
  const doc = await TimetableSlot.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Slot not found");
  if (req.staff?.role === "instructor") {
    const instructorBatches = await getInstructorAssignedBatchIds(req);
    const bid = String(doc.batch_id || "").trim().toLowerCase();
    if (!instructorBatches?.length || !bid || !instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "You can only delete slots in your assigned batches");
    }
  }
  const r = await TimetableSlot.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Slot not found");
  await fanoutTimetableSlotNotification(doc, "deleted");
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

/** —— Timetable events —— */
async function listTimetableEvents(req, res) {
  const fromStr = String(req.query.from || "").trim();
  const toStr = String(req.query.to || "").trim();
  const rangeMode =
    /^\d{4}-\d{2}-\d{2}$/.test(fromStr) && /^\d{4}-\d{2}-\d{2}$/.test(toStr);

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  const batchScopeFilter =
    instructorBatches !== null
      ? !instructorBatches.length
        ? { _id: null }
        : {
            $or: [
              { batch_id: { $in: instructorBatches } },
              { batch_id: "" },
              { batch_id: { $exists: false } },
            ],
          }
      : {};

  if (rangeMode) {
    const fromDate = new Date(`${fromStr}T00:00:00.000Z`);
    const toDate = new Date(`${toStr}T23:59:59.999Z`);
    const evFilter = { ...batchScopeFilter, date: { $gte: fromDate, $lte: toDate } };
    const items = await TimetableEvent.find(evFilter).sort({ date: 1 }).limit(500).lean();
    return sendSuccess(res, items.map((e) => ({ id: String(e._id), ...e })));
  }

  const { page, limit, skip } = paginate(req);
  const [items, total] = await Promise.all([
    TimetableEvent.find(batchScopeFilter).sort({ date: -1 }).skip(skip).limit(limit).lean(),
    TimetableEvent.countDocuments(batchScopeFilter),
  ]);
  return sendSuccess(
    res,
    items.map((e) => ({ id: String(e._id), ...e })),
    "",
    { page, limit, total }
  );
}

async function getTimetableEvent(req, res) {
  const doc = await TimetableEvent.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Event not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && instructorBatches.length) {
    const bid = String(doc.batch_id || "").trim().toLowerCase();
    if (bid && !instructorBatches.includes(bid)) {
      return sendError(res, 403, "FORBIDDEN", "Event is not for your assigned batches");
    }
  } else if (instructorBatches !== null && !instructorBatches.length) {
    return sendError(res, 403, "FORBIDDEN", "No batches assigned to your instructor profile");
  }
  return sendSuccess(res, { id: String(doc._id), ...doc });
}

async function createTimetableEvent(req, res) {
  const schema = z.object({
    title: z.string().min(1).trim(),
    type: z.enum(["holiday", "workshop", "mentor", "event"]),
    description: z.string().optional().default(""),
    date: z.coerce.date(),
    batch_id: z.string().optional().default(""),
  });
  const body = schema.parse(req.body);
  const created = await TimetableEvent.create({
    ...body,
    batch_id: (body.batch_id || "").toLowerCase().trim(),
  });
  return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
}

async function updateTimetableEvent(req, res) {
  const schema = z.object({
    title: z.string().optional(),
    type: z.enum(["holiday", "workshop", "mentor", "event"]).optional(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    batch_id: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const doc = await TimetableEvent.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Event not found");
  Object.assign(doc, body);
  if (body.batch_id !== undefined) doc.batch_id = (body.batch_id || "").toLowerCase().trim();
  await doc.save();
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
}

async function deleteTimetableEvent(req, res) {
  const r = await TimetableEvent.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Event not found");
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

/** —— Mentor slots —— */
async function listMentorSlotsAdmin(req, res) {
  const { page, limit, skip } = paginate(req);
  const [items, total] = await Promise.all([
    MentorSlot.find({}).sort({ date: 1 }).skip(skip).limit(limit).lean(),
    MentorSlot.countDocuments({}),
  ]);
  return sendSuccess(
    res,
    items.map((m) => ({
      id: String(m._id),
      subject: m.subject,
      mentor_name: m.mentor_name,
      mentor_info: m.mentor_info || "",
      date: m.date,
      publish_date: m.publish_date || null,
      time: m.time,
      duration_minutes: Number(m.duration_minutes || 60),
      meet_link: m.meet_link,
      target_batch_ids: Array.isArray(m.target_batch_ids) ? m.target_batch_ids : [],
      target_section_ids: Array.isArray(m.target_section_ids) ? m.target_section_ids : [],
      target_student_ids: Array.isArray(m.target_student_ids) ? m.target_student_ids.map((id) => String(id)) : [],
      booking_state: m.booking_state,
      booked_by: m.booked_by ? String(m.booked_by) : null,
      booked_at: m.booked_at,
    })),
    "",
    { page, limit, total }
  );
}

async function getMentorSlot(req, res) {
  const doc = await MentorSlot.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Mentor slot not found");
  return sendSuccess(res, {
    id: String(doc._id),
    ...doc,
    mentor_info: doc.mentor_info || "",
    publish_date: doc.publish_date || null,
    duration_minutes: Number(doc.duration_minutes || 60),
    target_batch_ids: Array.isArray(doc.target_batch_ids) ? doc.target_batch_ids : [],
    target_section_ids: Array.isArray(doc.target_section_ids) ? doc.target_section_ids : [],
    target_student_ids: Array.isArray(doc.target_student_ids) ? doc.target_student_ids.map((id) => String(id)) : [],
    booked_by: doc.booked_by ? String(doc.booked_by) : null,
  });
}

async function createMentorSlot(req, res) {
  const schema = z.object({
    mentor_name: z.string().min(1).trim(),
    mentor_info: z.string().trim().optional().default(""),
    date: z.coerce.date(),
    publish_date: z.coerce.date().optional(),
    time: z.string().min(1).trim(),
    duration_minutes: z.coerce.number().int().min(1).max(600).optional().default(60),
    meet_link: z.string().optional().default(""),
    target_batch_ids: z.array(z.string().trim().toLowerCase()).optional().default([]),
    target_section_ids: z.array(z.string().trim().toLowerCase()).optional().default([]),
    target_student_ids: z.array(z.string().trim()).optional().default([]),
    booking_state: z.enum(["open", "booked", "cancelled"]).optional(),
  });
  const body = schema.parse(req.body);
  if (new Date(body.date).getTime() <= Date.now()) {
    return sendError(res, 400, "VALIDATION_ERROR", "Session date must be in the future");
  }
  const targetStudentIds = body.target_student_ids.filter((id) => mongoose.isValidObjectId(id));
  const targetBatchIds = [...new Set(body.target_batch_ids.filter(Boolean))];
  const targetSectionIds = [...new Set(body.target_section_ids.filter(Boolean))];
  const created = await MentorSlot.create({
    subject: "Mentor Session",
    mentor_name: body.mentor_name,
    mentor_info: body.mentor_info || "",
    date: body.date,
    publish_date: body.publish_date || new Date(),
    time: body.time,
    duration_minutes: body.duration_minutes || 60,
    meet_link: body.meet_link || "",
    target_batch_ids: targetBatchIds,
    target_section_ids: targetSectionIds,
    target_student_ids: targetStudentIds,
    booking_state: body.booking_state || "open",
    booked_by: null,
    booked_at: null,
  });
  if (!body.publish_date || new Date(body.publish_date).getTime() <= Date.now()) {
    await fanoutMentorSlotNotification(created.toObject());
    try {
      await notifyMentorPublishEmail(created.toObject());
    } catch (err) {
      console.error("[MENTOR_EMAIL_SEND_FAILED]", err?.message || err);
    }
  }
  return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
}

async function updateMentorSlot(req, res) {
  const schema = z.object({
    mentor_name: z.string().optional(),
    mentor_info: z.string().optional(),
    date: z.coerce.date().optional(),
    publish_date: z.coerce.date().optional(),
    time: z.string().optional(),
    duration_minutes: z.coerce.number().int().min(1).max(600).optional(),
    meet_link: z.string().optional(),
    target_batch_ids: z.array(z.string().trim().toLowerCase()).optional(),
    target_section_ids: z.array(z.string().trim().toLowerCase()).optional(),
    target_student_ids: z.array(z.string().trim()).optional(),
    booking_state: z.enum(["open", "booked", "cancelled"]).optional(),
    booked_by: z.string().nullable().optional(),
    booked_at: z.coerce.date().nullable().optional(),
  });
  const body = schema.parse(req.body);
  const doc = await MentorSlot.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Mentor slot not found");
  const wasPublished = doc.publish_date ? new Date(doc.publish_date).getTime() <= Date.now() : true;
  if (body.mentor_name !== undefined) doc.mentor_name = body.mentor_name;
  if (body.mentor_info !== undefined) doc.mentor_info = body.mentor_info;
  if (body.date !== undefined) doc.date = body.date;
  if (body.publish_date !== undefined) doc.publish_date = body.publish_date;
  if (body.time !== undefined) doc.time = body.time;
  if (body.duration_minutes !== undefined) doc.duration_minutes = body.duration_minutes;
  if (body.meet_link !== undefined) doc.meet_link = body.meet_link;
  if (body.target_batch_ids !== undefined) doc.target_batch_ids = [...new Set(body.target_batch_ids.filter(Boolean))];
  if (body.target_section_ids !== undefined) {
    doc.target_section_ids = [...new Set(body.target_section_ids.filter(Boolean))];
  }
  if (body.target_student_ids !== undefined) {
    doc.target_student_ids = body.target_student_ids.filter((id) => mongoose.isValidObjectId(id));
  }
  if (body.booking_state !== undefined) doc.booking_state = body.booking_state;
  if (body.booked_by !== undefined) {
    doc.booked_by = body.booked_by && mongoose.isValidObjectId(body.booked_by) ? body.booked_by : null;
  }
  if (body.booked_at !== undefined) doc.booked_at = body.booked_at;
  if (new Date(doc.date).getTime() <= Date.now()) {
    return sendError(res, 400, "VALIDATION_ERROR", "Session date must be in the future");
  }
  await doc.save();
  const isPublishedNow = doc.publish_date ? new Date(doc.publish_date).getTime() <= Date.now() : true;
  if (!wasPublished && isPublishedNow) {
    const snapshot = doc.toObject();
    await fanoutMentorSlotNotification(snapshot);
    try {
      await notifyMentorPublishEmail(snapshot);
    } catch (err) {
      console.error("[MENTOR_EMAIL_SEND_FAILED]", err?.message || err);
    }
  }
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
}

async function googleMeetCalendarStatus(req, res) {
  return sendSuccess(res, {
    configured: googleMeetCal.isGoogleMeetCalendarConfigured(),
  });
}

async function provisionTimetableGoogleMeet(req, res) {
  const provisionSchema = z.object({
    batch_id: z.string().min(1).trim(),
    section_id: z.string().trim().optional().default(""),
    class_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().min(1).trim(),
    subject: z.string().min(1).trim(),
    topic: z.string().optional().default(""),
    teacher: z.string().min(1).trim(),
  });
  const body = provisionSchema.parse(req.body);

  if (!googleMeetCal.isGoogleMeetCalendarConfigured()) {
    return sendError(
      res,
      503,
      "NOT_CONFIGURED",
      "Google Calendar / Meet is not configured. Set GOOGLE_CALENDAR_* variables on the server and install googleapis."
    );
  }

  const filter = await catalogBatchStudentFilterResolved(body.batch_id.toLowerCase(), body.section_id);
  const students = await Student.find(filter).select("email").lean().limit(5000);
  const studentEmails = [
    ...new Set(students.map((s) => String(s.email || "").trim().toLowerCase()).filter(Boolean)),
  ];

  const teacherNameTrim = body.teacher.trim();
  let teacherEmail = "";
  const instructors = await Staff.find({ role: ROLES.INSTRUCTOR, is_active: true }).select("name email").lean();
  const instructorMatch = instructors.find(
    (row) => String(row.name || "").trim().toLowerCase() === teacherNameTrim.toLowerCase()
  );
  if (instructorMatch && String(instructorMatch.email || "").includes("@")) {
    teacherEmail = String(instructorMatch.email).trim().toLowerCase();
  }

  const attendeeSet = new Set(studentEmails);
  if (teacherEmail) attendeeSet.add(teacherEmail);
  const attendeeEmails = [...attendeeSet];

  const topicTxt = String(body.topic || "").trim();
  const title = `${body.subject.trim()}${topicTxt ? ` — ${topicTxt}` : ""}`;
  const description = [
    "CodeMasti live class",
    `Batch: ${body.batch_id.trim().toLowerCase()}${String(body.section_id || "").trim() ? ` · Section: ${String(body.section_id).trim()}` : ""}`,
    `Teacher: ${teacherNameTrim}`,
    topicTxt ? `Topic: ${topicTxt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await googleMeetCal.createMeetCalendarEvent({
      title,
      description,
      dateYmd: body.class_date.trim(),
      timeRange: body.time.trim(),
      attendeeEmails,
    });
    return sendSuccess(
      res,
      {
        meet_link: result.meetLink,
        html_link: result.htmlLink,
        event_id: result.eventId,
        attendee_count: result.attendeeEmails.length,
        student_count: studentEmails.length,
        instructor_email_included: Boolean(teacherEmail),
      },
      "Meet link created and calendar invites sent."
    );
  } catch (e) {
    console.error("[PROVISION_TIMETABLE_GOOGLE_MEET]", e?.message || e);
    return sendError(res, 502, "GOOGLE_MEET_FAILED", String(e.message || "Failed to create Meet"));
  }
}

async function deleteMentorSlot(req, res) {
  const r = await MentorSlot.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Mentor slot not found");
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

module.exports = {
  listAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  listAssignmentQuestions,
  createAssignmentQuestion,
  getAssignmentQuestion,
  updateAssignmentQuestion,
  deleteAssignmentQuestion,
  listArenaQuestions,
  getArenaQuestion,
  createArenaQuestion,
  updateArenaQuestion,
  deleteArenaQuestion,
  listLiveClasses,
  getLiveClass,
  createLiveClass,
  updateLiveClass,
  deleteLiveClass,
  listTimetableSlots,
  listTimetableSchedule,
  getTimetableSlot,
  createTimetableSlot,
  updateTimetableSlot,
  deleteTimetableSlot,
  googleMeetCalendarStatus,
  provisionTimetableGoogleMeet,
  listTimetableEvents,
  getTimetableEvent,
  createTimetableEvent,
  updateTimetableEvent,
  deleteTimetableEvent,
  listMentorSlotsAdmin,
  getMentorSlot,
  createMentorSlot,
  updateMentorSlot,
  deleteMentorSlot,
};
