const { z } = require("zod");
const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const BatchCatalog = require("../models/BatchCatalog");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaQuestion = require("../models/ArenaQuestion");
const ArenaSubmission = require("../models/ArenaSubmission");
const LiveClass = require("../models/LiveClass");
const TimetableSlot = require("../models/TimetableSlot");
const TimetableEvent = require("../models/TimetableEvent");
const MentorSlot = require("../models/MentorSlot");
const Student = require("../models/Student");
const Staff = require("../models/Staff");
const { sendSimpleEmail } = require("../services/brevo");
const {
  notifyStudentsForSlot,
  notifyStudentsClassStartingSoon,
  notifyStudentsTimetableSchedule,
  buildResourceUploadedEmail,
  fmtWhenLocal,
} = require("../services/student-notifications.service");
const {
  notifyInstructorsForSlot,
  buildResourceUploadedEmail: buildInstructorResourceEmail,
  buildClassCancelledEmail,
} = require("../services/instructor-notifications.service");
const { emitEventNotification } = require("../services/staffPanelNotification.service");
const {
  fanoutMentorSlotNotification,
  notifyMentorSlotCancelled,
} = require("../services/mentor-notification.service");
const {
  initLifecycleFieldsOnCreate: initMentorLifecycleFieldsOnCreate,
  handleMentorLifecycleOnPublish,
  handleMentorLifecycleAfterUpdate,
  mentorIdentityChanged,
  meetLinkChanged: mentorMeetLinkChanged,
  mentorScheduleChanged,
  resetMentorScheduleReminderMarkers,
  resetMentorOnlyReminderMarkers,
  apply60mSuppressionForCurrentSchedule: applyMentor60mSuppression,
} = require("../services/mentor-slot-lifecycle.service");
const { studentsInCatalogBatchesFilter, catalogBatchStudentFilter } = require("../utils/enrollment");
const { studentsInBatchesFilterResolved, catalogBatchStudentFilterResolved } = require("../utils/student-batch-context");
const { assignmentMatchesCatalogBatchId } = require("../utils/assignmentBatchFilter");
const {
  resolveAssignmentCreateTargets,
  validateSectionsForCatalog,
  sectionFieldsToStore,
  uniqueSectionIds,
} = require("../utils/assignmentSectionTargeting");
const { normalizeProjectDocument, hasProjectDocumentContent, emptyProjectDocument } = require("../utils/projectDocument");
const {
  mayCreateProjectQuestionPlaceholders,
  mayCreateProjectQuestion,
  isProjectAssignmentType,
  CANONICAL_PROJECT_SLOT,
  projectCreationSharedMetadataMatches,
  projectCreationPayloadMatches,
} = require("../utils/projectQuestionPolicy");
const { normalizeProjectMaxMarks, isDuplicateKeyError } = require("../services/project-submission.service");
const googleMeetCal = require("../services/google-calendar-meet.service");
const {
  initLifecycleFieldsOnCreate,
  handleInstructorLifecycleAfterCreate,
  handleInstructorLifecycleAfterUpdate,
  instructorIdentityChanged,
  meetLinkChanged,
  resetAllScheduleReminderMarkers,
  resetInstructorReminderMarkers,
  apply60mSuppressionForCurrentSchedule,
} = require("../services/timetable-instructor-lifecycle.service");
const { notifyAssignmentReleasedIfEligible } = require("../services/assignment-notifications.service");
const {
  assessProjectReadiness,
  projectPublicationStatus,
  publishedProjectDocumentUpdateError,
} = require("../utils/projectPublication");
const { evaluateWebSubmission } = require("../services/web-evaluator");
const { ROLES } = require("../utils/rbac");
const {
  getInstructorAssignedBatchIds,
  assignmentDocTouchesAllowedBatches,
  arenaDocTouchesAllowedBatches,
} = require("../utils/instructorBatchScope");
const { validateBatchSubject, invalidSubjectMessage } = require("../utils/catalog-subjects");
const {
  parseSlotStart,
  formatDateYmdInClassTimeZone,
  minutesUntilClassStart,
  IMMINENT_CLASS_MINUTES,
  normalizeTimeString,
} = require("../utils/timetable-slot-start");
const {
  parseGoogleMeetUrl,
  zGoogleMeetUrlRequired,
  zGoogleMeetUrlPatch,
} = require("../utils/google-meet-url");

/** Suppress "New class/event scheduled" spam when the item starts more than this many hours away. */
const SCHEDULE_NOTICE_MAX_HOURS_AHEAD = 6;

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

async function validateTargetsAgainstCatalog(res, targets) {
  const batchIds = [...new Set(targets.map((t) => t.batch_id))];
  const catalogs = await BatchCatalog.find({ batch_id: { $in: batchIds } }).select("batch_id sections").lean();
  const byId = new Map(catalogs.map((c) => [String(c.batch_id || "").toLowerCase(), c]));
  for (const t of targets) {
    const check = validateSectionsForCatalog(t.batch_id, t.section_ids, byId.get(t.batch_id) || null);
    if (!check.ok) {
      sendError(res, 400, check.code, check.message);
      return null;
    }
  }
  return targets;
}

const projectMediaItemSchema = z.object({
  url: z.string().trim().optional().default(""),
  label: z.string().trim().optional().default(""),
  caption: z.string().trim().optional(),
  title: z.string().trim().optional(),
  href: z.string().trim().optional(),
});

const projectDocumentSchema = z.object({
  overview: z.string().optional().default(""),
  prerequisites: z.string().optional().default(""),
  deliverables: z.string().optional().default(""),
  steps: z
    .array(
      z.object({
        step_id: z.string().trim().optional(),
        id: z.string().trim().optional(),
        title: z.string().optional().default(""),
        content: z.string().optional().default(""),
        images: z.array(projectMediaItemSchema).optional().default([]),
        videos: z.array(projectMediaItemSchema).optional().default([]),
        resources: z.array(projectMediaItemSchema).optional().default([]),
      })
    )
    .optional()
    .default([]),
});

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

/**
 * Student timetable notifications: schedule fan-out or imminent class reminder (never both).
 * - created/updated within SCHEDULE_NOTICE_MAX_HOURS_AHEAD and >15 min away → "New class scheduled" / "Class schedule updated"
 * - created/updated > SCHEDULE_NOTICE_MAX_HOURS_AHEAD away → no schedule notice (avoids bulk-planning spam)
 * - created/updated ≤15 min away → single "Class starts soon" reminder
 *   (marks 10m sent only when Meet link is present; otherwise cron can still send join-ready reminder later)
 * - deleted → "Class cancelled" (always)
 */
async function handleStudentTimetableNotifications(slot, action) {
  if (action === "deleted") {
    await notifyStudentsTimetableSchedule({ slot, action: "deleted" });
    return;
  }

  const mins = minutesUntilClassStart(slot);
  if (mins !== null && mins > 0 && mins <= IMMINENT_CLASS_MINUTES) {
    const whenText = fmtWhenLocal(slot.class_date, slot.time);
    await notifyStudentsClassStartingSoon({ slot, minutesUntil: mins, whenText });
    const slotId = slot._id || slot.id;
    const meet = String(slot.meet_link || "").trim();
    // Match scheduler: only mark 10m sent when Meet exists so cron can send join reminder after link is added.
    if (slotId && meet) {
      await TimetableSlot.updateOne(
        { _id: slotId },
        { $set: { student_reminder_10m_sent_at: new Date() } }
      );
    }
    return;
  }

  // Bulk month-planning creates dozens of far-future slots; skip "scheduled" notices for those.
  if (mins !== null && mins > SCHEDULE_NOTICE_MAX_HOURS_AHEAD * 60) {
    return;
  }

  await notifyStudentsTimetableSchedule({ slot, action });
}

/** —— Assignments —— */
async function projectStaffFlags(assignment) {
  if (!isProjectAssignmentType(assignment?.assignment_type)) {
    return {
      project_publication_status: "n/a",
      project_ready: true,
      project_ready_errors: [],
      xp_locked: false,
      max_marks_locked: false,
    };
  }
  const assignmentId = assignment._id || assignment.id;
  const [ready, acceptedCount, evaluatedCount] = await Promise.all([
    assessProjectReadiness(assignment),
    AssignmentSubmission.countDocuments({
      assignment_id: assignmentId,
      kind: "project",
      status: "Accepted",
    }),
    AssignmentSubmission.countDocuments({
      assignment_id: assignmentId,
      kind: "project",
      "project.review_status": "evaluated",
    }),
  ]);
  return {
    project_publication_status: projectPublicationStatus(assignment),
    project_ready: Boolean(ready.ok),
    project_ready_errors: ready.ok ? [] : ready.details || [ready.message],
    xp_locked: acceptedCount > 0,
    max_marks_locked: evaluatedCount > 0,
  };
}

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
  const creationGroupId = String(req.query.creation_group_id || "").trim();

  const clauses = [];
  if (subject) clauses.push({ subject });
  if (creationGroupId) {
    clauses.push({ creation_group_id: creationGroupId, assignment_type: "project" });
  }
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
  const extra = await projectStaffFlags(doc);
  return sendSuccess(res, { id: String(doc._id), ...doc, ...extra });
}

async function createAssignment(req, res) {
  const schema = z
    .object({
      batch_targets: z
        .array(
          z.object({
            batch_id: z.string().min(1).trim(),
            section_ids: z.array(z.string().trim()).optional().default([]),
          })
        )
        .optional(),
      batch_ids: z.array(z.string().min(1).trim()).optional().default([]),
      batch_id: z.string().min(1).trim().optional(),
      title: z.string().min(1).trim().optional().default(""),
      section_id: z.string().trim().optional().default(""),
      section_ids: z.array(z.string().trim()).optional(),
      subject: z.string().min(1).trim(),
      module: z.string().min(1).trim(),
      assignment_type: z.enum(["quiz", "coding", "written", "web", "project", "other"]).optional().default("written"),
      programming_language: z.enum(["python", "javascript"]).optional().default("python"),
      release_date: z.coerce.date(),
      deadline_date: z.coerce.date(),
      question_count: z.number().int().min(0).max(200).optional().default(0),
      resource_url: z.string().trim().optional().default(""),
      resource_size: z.string().trim().optional().default(""),
      project_max_marks: z.number().min(0).max(1000).optional(),
      creation_group_id: z.string().trim().max(80).optional().default(""),
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

  const resolved = resolveAssignmentCreateTargets(body);
  if (!resolved.ok) {
    return sendError(res, 400, resolved.code, resolved.message);
  }
  const targets = await validateTargetsAgainstCatalog(res, resolved.targets);
  if (!targets) return;

  if (instructorBatches !== null) {
    const allow = new Set(instructorBatches);
    for (const t of targets) {
      if (!allow.has(t.batch_id)) {
        return sendError(res, 403, "FORBIDDEN", "You can only create assignments for your assigned batches");
      }
    }
  }

  const batchIds = targets.map((t) => t.batch_id);
  const subjCheck = await resolveCatalogSubjectOrError(res, batchIds, body.subject);
  if (!subjCheck.ok) return;
  body.subject = subjCheck.value;

  const isProject = isProjectAssignmentType(body.assignment_type);
  const placeholderGate = mayCreateProjectQuestionPlaceholders(body.assignment_type, body.question_count);
  if (!placeholderGate.ok) {
    return sendError(res, 400, placeholderGate.code, placeholderGate.message);
  }

  const groupId = isProject ? String(body.creation_group_id || "").trim() : "";
  const createMaxMarks = normalizeProjectMaxMarks(body.project_max_marks, 100);
  const createIdentity = {
    title: body.title || "",
    subject: body.subject,
    module: body.module,
    release_date: body.release_date,
    deadline_date: body.deadline_date,
    project_max_marks: createMaxMarks,
  };

  if (isProject && groupId) {
    const existingForGroup = await Assignment.find({
      creation_group_id: groupId,
      assignment_type: "project",
    }).lean();
    const targetByBatch = new Map(targets.map((t) => [t.batch_id, t]));
    for (const row of existingForGroup) {
      if (!projectCreationSharedMetadataMatches(row, createIdentity)) {
        return sendError(
          res,
          409,
          "CREATION_GROUP_CONFLICT",
          "This creation group already created a different Project. Retry with the original title, subject, module, dates, and marks, or use a new creation_group_id.",
          { existing_id: String(row._id), batch_id: row.batch_id }
        );
      }
      const target = targetByBatch.get(String(row.batch_id || "").toLowerCase().trim());
      if (target && !projectCreationPayloadMatches(row, { ...createIdentity, section_ids: target.section_ids })) {
        return sendError(
          res,
          409,
          "CREATION_GROUP_CONFLICT",
          "This creation group already created a Project for this batch with different section targeting. Retry with the original sections, or use a new creation_group_id.",
          { existing_id: String(row._id), batch_id: row.batch_id }
        );
      }
    }
  }

  async function recoveredProjectHeader(existing) {
    const questionCount = await AssignmentQuestion.countDocuments({ assignment_id: existing._id });
    const obj = typeof existing.toObject === "function" ? existing.toObject() : existing;
    return {
      id: String(existing._id),
      ...obj,
      question_count: questionCount,
      recovered: true,
    };
  }

  const createdAssignments = [];
  for (const t of targets) {
    const sectionStore = sectionFieldsToStore(t.section_ids);
    if (isProject && groupId) {
      const existing = await Assignment.findOne({
        creation_group_id: groupId,
        batch_id: t.batch_id,
        assignment_type: "project",
      });
      if (existing) {
        if (!projectCreationPayloadMatches(existing, { ...createIdentity, section_ids: t.section_ids })) {
          return sendError(
            res,
            409,
            "CREATION_GROUP_CONFLICT",
            "This creation group already created a different Project for this batch. Retry with the original payload, or use a new creation_group_id.",
            { existing_id: String(existing._id), batch_id: t.batch_id }
          );
        }
        createdAssignments.push(await recoveredProjectHeader(existing));
        continue;
      }
    }

    let created;
    try {
      created = await Assignment.create({
        batch_id: t.batch_id,
        batch_ids: [t.batch_id],
        section_id: sectionStore.section_id,
        section_ids: sectionStore.section_ids,
        title: body.title || "",
        subject: body.subject,
        module: body.module,
        assignment_type: body.assignment_type,
        programming_language: body.programming_language,
        release_date: body.release_date,
        deadline_date: body.deadline_date,
        resource_url: body.resource_url || "",
        resource_size: body.resource_size || "",
        project_max_marks: createMaxMarks,
        ...(isProject ? { project_published: false, creation_group_id: groupId } : {}),
      });
    } catch (err) {
      if (!(isProject && groupId && isDuplicateKeyError(err))) throw err;
      const raced = await Assignment.findOne({
        creation_group_id: groupId,
        batch_id: t.batch_id,
        assignment_type: "project",
      });
      if (!raced) throw err;
      if (!projectCreationPayloadMatches(raced, { ...createIdentity, section_ids: t.section_ids })) {
        return sendError(
          res,
          409,
          "CREATION_GROUP_CONFLICT",
          "This creation group already created a different Project for this batch. Retry with the original payload, or use a new creation_group_id.",
          { existing_id: String(raced._id), batch_id: t.batch_id }
        );
      }
      createdAssignments.push(await recoveredProjectHeader(raced));
      continue;
    }

    let questionCount = 0;
    if (body.question_count > 0) {
      const placeholders = Array.from({ length: body.question_count }, (_, idx) => {
        const n = idx + 1;
        const title = isProject ? body.title || "Project" : `Question ${n}`;
        return {
          assignment_id: created._id,
          name: slugifyQuestionName(isProject ? "project-document" : `question-${n}`),
          title,
          description: isProject ? "Project assignment" : "Add question description.",
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
          project_document: isProject ? emptyProjectDocument() : undefined,
          ...(isProject ? { project_slot: CANONICAL_PROJECT_SLOT } : {}),
        };
      });
      try {
        await AssignmentQuestion.insertMany(placeholders);
        questionCount = placeholders.length;
      } catch (err) {
        if (!(isProject && isDuplicateKeyError(err))) throw err;
        questionCount = await AssignmentQuestion.countDocuments({ assignment_id: created._id });
      }
    }

    if (!isProject) {
      try {
        await notifyAssignmentReleasedIfEligible(created.toObject());
      } catch (e) {
        console.warn("[ASSIGNMENT_NOTIFY_FANOUT]", e?.message || e);
      }
    }

    createdAssignments.push({
      id: String(created._id),
      ...created.toObject(),
      question_count: questionCount,
    });
  }

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
    section_ids: z.array(z.string().trim()).optional(),
    subject: z.string().min(1).trim().optional(),
    module: z.string().min(1).trim().optional(),
    assignment_type: z.enum(["quiz", "coding", "written", "web", "project", "other"]).optional(),
    programming_language: z.enum(["python", "javascript"]).optional(),
    release_date: z.coerce.date().optional(),
    deadline_date: z.coerce.date().optional(),
    resource_url: z.string().trim().optional(),
    resource_size: z.string().trim().optional(),
    project_max_marks: z.number().min(0).max(1000).optional(),
    project_published: z.boolean().optional(),
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

  if (body.batch_ids !== undefined && body.batch_ids.length > 0) {
    const normalized = body.batch_ids.map((x) => String(x || "").toLowerCase().trim()).filter(Boolean);
    doc.batch_ids = normalized;
    doc.batch_id = normalized[0] || "";
  } else if (body.batch_id !== undefined) {
    const one = body.batch_id ? body.batch_id.toLowerCase().trim() : "";
    doc.batch_id = one;
    doc.batch_ids = one ? [one] : [];
  }

  if (body.section_ids !== undefined || body.section_id !== undefined) {
    const nextIds =
      body.section_ids !== undefined
        ? uniqueSectionIds(body.section_ids)
        : uniqueSectionIds([body.section_id]);
    const catalogBid = String(doc.batch_id || "").toLowerCase().trim();
    if (nextIds.length && catalogBid) {
      const cat = await BatchCatalog.findOne({ batch_id: catalogBid }).select("batch_id sections").lean();
      const check = validateSectionsForCatalog(catalogBid, nextIds, cat);
      if (!check.ok) return sendError(res, 400, check.code, check.message);
    } else if (nextIds.length && !catalogBid) {
      return sendError(res, 400, "BATCH_REQUIRED", "Cannot set section targeting on an unscoped assignment.");
    }
    const stored = sectionFieldsToStore(nextIds);
    doc.section_ids = stored.section_ids;
    doc.section_id = stored.section_id;
  }

  if (body.subject !== undefined) {
    const subjCheck = await resolveCatalogSubjectOrError(res, doc.batch_ids, body.subject);
    if (!subjCheck.ok) return;
    body.subject = subjCheck.value;
  }

  const { batch_id: _b, batch_ids: _bs, section_id: _s, section_ids: _ss, project_published: publishedFlag, ...rest } = body;
  if (publishedFlag !== undefined) {
    return sendError(
      res,
      400,
      "USE_PROJECT_PUBLISH",
      "Use POST /admin/assignments/:id/project-publish or project-unpublish to change Project publication."
    );
  }
  if (rest.project_max_marks !== undefined) {
    rest.project_max_marks = normalizeProjectMaxMarks(rest.project_max_marks, 100);
    if (isProjectAssignmentType(doc.assignment_type)) {
      const evaluatedCount = await AssignmentSubmission.countDocuments({
        assignment_id: doc._id,
        kind: "project",
        "project.review_status": "evaluated",
      });
      if (evaluatedCount > 0 && Number(rest.project_max_marks) !== Number(doc.project_max_marks)) {
        return sendError(
          res,
          409,
          "PROJECT_MAX_MARKS_LOCKED",
          "Maximum marks cannot change after at least one student has been evaluated."
        );
      }
    }
  }
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
  if (!isProjectAssignmentType(doc.assignment_type) || doc.project_published === true) {
    try {
      await notifyAssignmentReleasedIfEligible(doc.toObject());
    } catch (e) {
      console.warn("[ASSIGNMENT_NOTIFY_FANOUT_UPDATE]", e?.message || e);
    }
  }
  const extra = await projectStaffFlags(doc.toObject());
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject(), ...extra }, "Updated");
}

async function publishProjectAssignment(req, res) {
  const doc = await Assignment.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(doc, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  if (!isProjectAssignmentType(doc.assignment_type)) {
    return sendError(res, 400, "NOT_A_PROJECT", "Only Project assignments can be published with this endpoint.");
  }
  const ready = await assessProjectReadiness(doc.toObject());
  if (!ready.ok) {
    return sendError(res, 400, ready.code || "PROJECT_NOT_READY", ready.message, {
      details: ready.details || [],
    });
  }
  doc.project_published = true;
  await doc.save();
  try {
    await notifyAssignmentReleasedIfEligible(doc.toObject());
  } catch (e) {
    console.warn("[ASSIGNMENT_NOTIFY_FANOUT_PUBLISH]", e?.message || e);
  }
  const extra = await projectStaffFlags(doc.toObject());
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject(), ...extra }, "Published");
}

async function unpublishProjectAssignment(req, res) {
  const doc = await Assignment.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Assignment not found");
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !assignmentDocTouchesAllowedBatches(doc, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Assignment is not for your assigned batches");
  }
  if (!isProjectAssignmentType(doc.assignment_type)) {
    return sendError(res, 400, "NOT_A_PROJECT", "Only Project assignments can be unpublished with this endpoint.");
  }
  doc.project_published = false;
  await doc.save();
  const extra = await projectStaffFlags(doc.toObject());
  return sendSuccess(
    res,
    { id: String(doc._id), ...doc.toObject(), ...extra },
    "Unpublished. Existing submissions and XP were not changed."
  );
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
      has_project_document: hasProjectDocumentContent(q.project_document),
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
  question_video_url: z.string().trim().optional(),
  code: z.string().optional(),
  code_language: z.string().trim().optional(),
  quiz_options: z
    .array(
      z.object({
        text: z.string().trim().optional().default(""),
        code: z.string().optional().default(""),
        image_url: z.string().trim().optional().default(""),
        is_correct: z.boolean().optional().default(false),
      })
    )
    .optional(),
  // Written-answer fields
  min_word_count:   z.number().int().min(10).max(5000).optional(),
  max_word_count:   z.number().int().min(50).max(10000).optional(),
  ideal_answer:     z.string().optional(),
  expected_topics:  z.array(z.string().trim()).optional(),
  scoring_rubric:   z
    .array(
      z.object({
        dimension:   z.string().trim().min(1),
        weight:      z.number().min(0).optional().default(1),
        max_score:   z.number().min(1).max(10).optional().default(5),
        description: z.string().optional().default(""),
      })
    )
    .optional(),
  // Web (HTML/CSS) fields
  html_starter:     z.string().optional().default(""),
  css_starter:      z.string().optional().default(""),
  // Author-only reference solution used to verify dom_tests; never sent to students.
  solution_html:    z.string().optional().default(""),
  solution_css:     z.string().optional().default(""),
  dom_tests: z
    .array(
      z.object({
        label:          z.string().trim().min(1),
        check_type:     z.enum(["element_exists","element_text","element_attribute","element_count","css_rule_exists","css_property"]),
        selector:       z.string().optional().default(""),
        expected_value: z.string().optional().default(""),
        attribute_name: z.string().optional().default(""),
        property_name:  z.string().optional().default(""),
        expected_count: z.number().int().min(0).optional().default(0),
      })
    )
    .max(30, "Maximum 30 DOM checks allowed.")
    .optional(),
  project_document: projectDocumentSchema.optional(),
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
  const isProject = isProjectAssignmentType(a.assignment_type);
  if (!isProject && body.project_document !== undefined) {
    return sendError(res, 400, "INVALID_FIELD", "project_document is only allowed on project assignments.");
  }
  if (isProject) {
    const existing = await AssignmentQuestion.countDocuments({ assignment_id: assignmentId });
    const gate = mayCreateProjectQuestion(a.assignment_type, existing);
    if (!gate.ok) {
      return sendError(res, 409, gate.code, gate.message);
    }
  }
  if (body.project_document !== undefined) {
    const n = normalizeProjectDocument(body.project_document);
    if (!n.ok) return sendError(res, 400, "INVALID_PROJECT_DOCUMENT", n.message);
    body.project_document = n.value;
  } else if (isProject) {
    body.project_document = emptyProjectDocument();
  }
  const publishedDocErr = publishedProjectDocumentUpdateError(a, isProject ? body.project_document : undefined);
  if (publishedDocErr) {
    return sendError(res, 400, publishedDocErr.code, publishedDocErr.message);
  }
  const computedName = slugifyQuestionName(body.name || (isProject ? "project-document" : body.title));
  try {
    const created = await AssignmentQuestion.create({
      assignment_id: assignmentId,
      ...body,
      name: computedName,
      starter_code: body.starter_code || {},
      hidden_tests: body.hidden_tests || [],
      dom_tests: body.dom_tests || [],
      html_starter: body.html_starter || "",
      css_starter: body.css_starter || "",
      ...(isProject ? { project_slot: CANONICAL_PROJECT_SLOT } : {}),
    });
    return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
  } catch (err) {
    if (!(isProject && isDuplicateKeyError(err))) throw err;
    const raced = await AssignmentQuestion.findOne({
      assignment_id: assignmentId,
      project_slot: CANONICAL_PROJECT_SLOT,
    });
    if (!raced) throw err;
    return sendSuccess(res, { id: String(raced._id), ...raced.toObject(), recovered: true }, "Created");
  }
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
  const isProject = isProjectAssignmentType(a.assignment_type);
  if (!isProject && body.project_document !== undefined) {
    return sendError(res, 400, "INVALID_FIELD", "project_document is only allowed on project assignments.");
  }
  if (isProject && body.xp !== undefined && Number(body.xp) !== Number(q.xp)) {
    const acceptedCount = await AssignmentSubmission.countDocuments({
      assignment_id: assignmentId,
      kind: "project",
      status: "Accepted",
    });
    if (acceptedCount > 0) {
      return sendError(
        res,
        409,
        "PROJECT_XP_LOCKED",
        "XP cannot change after a student has successfully submitted this project."
      );
    }
  }
  if (body.project_document !== undefined) {
    const n = normalizeProjectDocument(body.project_document);
    if (!n.ok) return sendError(res, 400, "INVALID_PROJECT_DOCUMENT", n.message);
    body.project_document = n.value;
  }
  const publishedDocErr = publishedProjectDocumentUpdateError(a, body.project_document);
  if (publishedDocErr) {
    return sendError(res, 400, publishedDocErr.code, publishedDocErr.message);
  }
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
  if (isProjectAssignmentType(a.assignment_type) && a.project_published === true) {
    return sendError(
      res,
      409,
      "PROJECT_PUBLISHED_QUESTION_LOCKED",
      "Cannot delete the project document while the assignment is published. Unpublish first."
    );
  }
  await AssignmentSubmission.deleteMany({ question_id: questionId });
  await AssignmentQuestion.deleteOne({ _id: questionId });
  return sendSuccess(res, { id: questionId }, "Deleted");
}

/**
 * Authoring aid: run the SAME web grader students hit against a reference solution,
 * so an author can confirm their dom_tests actually pass on a correct answer before
 * shipping. Stateless — nothing is read from or written to the database.
 */
const verifyWebChecksSchema = z.object({
  html: z.string().optional().default(""),
  css: z.string().optional().default(""),
  dom_tests: z
    .array(
      z.object({
        label: z.string().optional().default(""),
        check_type: z.string(),
        selector: z.string().optional().default(""),
        expected_value: z.string().optional().default(""),
        attribute_name: z.string().optional().default(""),
        property_name: z.string().optional().default(""),
        expected_count: z.number().int().min(0).optional().default(0),
      })
    )
    .max(30, "Maximum 30 checks.")
    .optional()
    .default([]),
});

async function verifyWebChecks(req, res) {
  const body = verifyWebChecksSchema.parse(req.body);
  try {
    const result = evaluateWebSubmission({
      html: body.html,
      css: body.css,
      domTests: body.dom_tests,
    });
    return sendSuccess(res, result);
  } catch (e) {
    if (e && e.statusCode === 413) {
      return sendError(res, 413, "SUBMISSION_TOO_LARGE", e.message);
    }
    return sendError(res, 400, "VERIFY_FAILED", e?.message || "Could not verify checks.");
  }
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
  question_video_url: z.string().trim().nullable().optional(),
  quiz_options: z
    .array(
      z.object({
        text: z.string().trim().optional().default(""),
        code: z.string().optional().default(""),
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
    const instructorId = String(req.staff?.sub || "").trim();
    // Require at least one identity signal; missing both means the profile is incomplete.
    if (!ownName && !instructorId) return sendSuccess(res, []);
    if (!instructorBatches?.length) return sendSuccess(res, []);
    filter.batch_id = { $in: instructorBatches };
    // Match by staff_id (set when admin picks instructor from dropdown) OR by display name.
    // This is more resilient: staff_id survives instructor name changes; name match is the legacy fallback.
    const orClauses = [];
    if (instructorId && mongoose.isValidObjectId(instructorId)) {
      orClauses.push({ staff_id: new mongoose.Types.ObjectId(instructorId) });
    }
    if (ownName) {
      orClauses.push({ teacher: { $regex: new RegExp(`^${escapeRegex(ownName)}$`, "i") } });
    }
    if (orClauses.length === 1) {
      Object.assign(filter, orClauses[0]);
    } else {
      filter.$or = orClauses;
    }
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
    staff_id: slot.staff_id ? String(slot.staff_id) : null,
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
    staff_id: z.string().optional(),
    meet_link: zGoogleMeetUrlRequired(),
    recording_link: z.string().optional().default(""),
    notes_link: z.string().optional().default(""),
    is_taken: z.boolean().optional().default(false),
    /** When true, also email students and instructors for recording/notes uploads; in-app notices always go out. */
    notify_resource_by_email: z.boolean().optional().default(false),
  });
  const body = schema.parse(req.body);
  // Normalize time string to ensure consistent format stored in DB (e.g. "11:35-12:5" → "11:35-12:05").
  body.time = normalizeTimeString(body.time);
  const notifyResourceByEmail = body.notify_resource_by_email === true;
  const subjCheck = await resolveCatalogSubjectOrError(res, [body.batch_id], body.subject);
  if (!subjCheck.ok) return;
  body.subject = subjCheck.value;
  const derivedDay = weekdayFromDateString(body.class_date);
  if (!derivedDay) return sendError(res, 400, "VALIDATION_ERROR", "Invalid class_date");

  const mongoose = require("mongoose");
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
    staff_id: body.staff_id && mongoose.isValidObjectId(body.staff_id) ? body.staff_id : null,
    meet_link: parseGoogleMeetUrl(body.meet_link) || body.meet_link.trim(),
    recording_link: String(body.recording_link || "").trim(),
    notes_link: String(body.notes_link || "").trim(),
    is_taken: Boolean(body.is_taken),
    },
  ];

  for (const row of docs) {
    initLifecycleFieldsOnCreate(row);
  }

  const created = await TimetableSlot.insertMany(docs, { ordered: false });
  for (const row of created) {
    const slot = row.toObject();
    const hasRecording = Boolean(String(slot.recording_link || "").trim());
    const hasNotes = Boolean(String(slot.notes_link || "").trim());

    try {
      await handleInstructorLifecycleAfterCreate(slot);
    } catch (e) {
      console.error("[TIMETABLE_CLASS_ASSIGNED_ON_CREATE_FAILED]", e?.message || e);
    }

    // Only send generic timetable-created notification when no resources are attached.
    // If resources are already present, the specific resource notifications below are sent instead.
    if (!hasRecording && !hasNotes) {
      await handleStudentTimetableNotifications(slot, "created");
    }

    if (hasRecording) {
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
      await notifyInstructorsForSlot({
        slot,
        event_type: "timetable_recording_uploaded",
        title: "Recording uploaded",
        message: `Recording link added for ${slot.subject} (${whenText}).`,
        action_url: slot.recording_link || "",
        emailBuilder: notifyResourceByEmail
          ? ({ staff }) => buildInstructorResourceEmail({ staffName: staff?.name, slot, kind: "recording" })
          : undefined,
      });
    }
    if (hasNotes) {
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
      await notifyInstructorsForSlot({
        slot,
        event_type: "timetable_notes_uploaded",
        title: "Notes uploaded",
        message: `Notes link added for ${slot.subject} (${whenText}).`,
        action_url: slot.notes_link || "",
        emailBuilder: notifyResourceByEmail
          ? ({ staff }) => buildInstructorResourceEmail({ staffName: staff?.name, slot, kind: "notes" })
          : undefined,
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
    staff_id: z.string().optional(),
    meet_link: zGoogleMeetUrlPatch(),
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
  const prevMeetLink = String(doc.meet_link || "").trim();
  const prevStaffId = String(doc.staff_id || "").trim();
  const prevTeacher = String(doc.teacher || "").trim();
  if (body.batch_id !== undefined) doc.batch_id = body.batch_id.toLowerCase().trim();
  if (body.section_id !== undefined) doc.section_id = (body.section_id || "").toLowerCase().trim();
  if (body.time !== undefined) body.time = normalizeTimeString(body.time);
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
  if (body.staff_id !== undefined) {
    const mongoose = require("mongoose");
    doc.staff_id = body.staff_id && mongoose.isValidObjectId(body.staff_id) ? body.staff_id : null;
  }
  if (body.meet_link !== undefined) {
    doc.meet_link = parseGoogleMeetUrl(body.meet_link) || body.meet_link.trim();
  }
  if (body.recording_link !== undefined) doc.recording_link = String(body.recording_link || "").trim();
  if (body.notes_link !== undefined) doc.notes_link = String(body.notes_link || "").trim();
  if (body.is_taken !== undefined) doc.is_taken = Boolean(body.is_taken);

  const nextClassDate = String(doc.class_date || "").trim();
  const nextTime = String(doc.time || "").trim();
  const nextMeetLink = String(doc.meet_link || "").trim();
  const nextStaffId = String(doc.staff_id || "").trim();
  const nextTeacher = String(doc.teacher || "").trim();
  const scheduleChanged = prevClassDate !== nextClassDate || prevTime !== nextTime;
  const instructorChanged = instructorIdentityChanged(
    prevStaffId,
    prevTeacher,
    nextStaffId,
    nextTeacher
  );
  const meetChanged = meetLinkChanged(prevMeetLink, nextMeetLink);
  const previousSchedule = { class_date: prevClassDate, time: prevTime };
  const previousInstructor = { staff_id: prevStaffId || null, teacher: prevTeacher };

  if (scheduleChanged) {
    doc.schedule_revision = (Number(doc.schedule_revision) || 1) + 1;
    resetAllScheduleReminderMarkers(doc);
  }

  if (instructorChanged) {
    doc.instructor_assignment_revision = (Number(doc.instructor_assignment_revision) || 1) + 1;
    if (!scheduleChanged) {
      resetInstructorReminderMarkers(doc);
    }
  }

  if (meetChanged && !scheduleChanged && !instructorChanged) {
    doc.meet_link_revision = (Number(doc.meet_link_revision) || 1) + 1;
  }

  if (scheduleChanged || instructorChanged) {
    apply60mSuppressionForCurrentSchedule(doc);
  }

  await doc.save();

  try {
    await handleInstructorLifecycleAfterUpdate({
      slot: doc,
      scheduleChanged,
      instructorChanged,
      meetLinkChanged: meetChanged,
      previousSchedule: scheduleChanged ? previousSchedule : undefined,
      previousInstructor: instructorChanged ? previousInstructor : undefined,
    });
  } catch (e) {
    console.error("[TIMETABLE_INSTRUCTOR_LIFECYCLE_UPDATE_FAILED]", e?.message || e);
  }

  // Determine what actually changed.
  const nextRecording = String(doc.recording_link || "").trim();
  const nextNotes = String(doc.notes_link || "").trim();
  const onlyResourcesChanged =
    !prevRecording && !prevNotes && (nextRecording || nextNotes) &&
    body.batch_id === undefined &&
    body.section_id === undefined &&
    body.class_date === undefined &&
    body.time === undefined &&
    body.subject === undefined &&
    body.topic === undefined &&
    body.teacher === undefined &&
    body.meet_link === undefined &&
    body.is_taken === undefined;

  // Skip the generic "timetable updated" notification when ONLY resource links were added — the
  // more specific recording_uploaded / notes_uploaded notifications will fire below instead.
  if (!onlyResourcesChanged) {
    await handleStudentTimetableNotifications(doc.toObject(), "updated");
  }
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
      action_url: nextRecording,
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
      action_url: nextNotes,
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
  const r = await TimetableSlot.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Slot not found");
  await handleStudentTimetableNotifications(doc, "deleted");
  // Instructor was previously never told their class was cancelled — only students were.
  try {
    await notifyInstructorsForSlot({
      slot: doc,
      event_type: "timetable_class_cancelled",
      title: "Class cancelled",
      message: `${doc.subject}${doc.topic ? ` — ${doc.topic}` : ""} on ${fmtWhenLocal(doc.class_date, doc.time)} was cancelled.`,
      action_url: "/dashboard/instructor/timetable",
      emailBuilder: ({ staff }) => buildClassCancelledEmail({ staffName: staff?.name, slot: doc }),
    });
  } catch (e) {
    console.error("[INSTRUCTOR_CLASS_CANCELLED_NOTIFY_FAILED]", e?.message || e);
  }
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

/** —— Timetable events —— */
async function listTimetableEvents(req, res) {
  const fromStr = String(req.query.from || "").trim();
  const toStr = String(req.query.to || "").trim();
  const explicitRangeMode =
    /^\d{4}-\d{2}-\d{2}$/.test(fromStr) && /^\d{4}-\d{2}-\d{2}$/.test(toStr);

  const batchId = String(req.query.batch_id || "").trim().toLowerCase();
  const sectionId = String(req.query.section_id || "").trim().toLowerCase();
  const month = Number(req.query.month || 0);
  let year = Number(req.query.year || 0);
  if (month >= 1 && month <= 12 && !(year >= 1900 && year <= 9999)) {
    year = new Date().getFullYear();
  }
  // Event `date` is stored as UTC midnight of the picked calendar day (see createTimetableEvent),
  // so month bucketing can use plain UTC month boundaries — no class-timezone conversion needed.
  const monthRangeMode = !explicitRangeMode && year >= 1900;

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

  const clauses = [];
  if (Object.keys(batchScopeFilter).length) clauses.push(batchScopeFilter);
  // batch_id "" on an event means "all batches", so a batch-scoped query still matches it.
  if (batchId) {
    clauses.push({ $or: [{ batch_id: batchId }, { batch_id: "" }, { batch_id: { $exists: false } }] });
  }
  if (sectionId) {
    clauses.push({ $or: [{ section_id: "" }, { section_id: { $exists: false } }, { section_id: sectionId }] });
  }

  if (explicitRangeMode || monthRangeMode) {
    let fromDate;
    let toDate;
    if (explicitRangeMode) {
      fromDate = new Date(`${fromStr}T00:00:00.000Z`);
      toDate = new Date(`${toStr}T23:59:59.999Z`);
    } else {
      const mm = month >= 1 && month <= 12 ? month : 1;
      const lastMonth = month >= 1 && month <= 12 ? month : 12;
      fromDate = new Date(Date.UTC(year, mm - 1, 1, 0, 0, 0, 0));
      toDate = new Date(Date.UTC(year, lastMonth, 0, 23, 59, 59, 999));
    }
    clauses.push({ date: { $gte: fromDate, $lte: toDate } });
    const evFilter = clauses.length === 1 ? clauses[0] : { $and: clauses };
    const items = await TimetableEvent.find(evFilter).sort({ date: 1 }).limit(500).lean();
    return sendSuccess(res, items.map((e) => ({ id: String(e._id), ...e })));
  }

  const { page, limit, skip } = paginate(req);
  const pageFilter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };
  const [items, total] = await Promise.all([
    TimetableEvent.find(pageFilter).sort({ date: -1 }).skip(skip).limit(limit).lean(),
    TimetableEvent.countDocuments(pageFilter),
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

const TIME_HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const timetableEventFieldsSchema = {
  title: z.string().min(1).trim(),
  type: z.enum(TimetableEvent.EVENT_TYPES),
  description: z.string().optional().default(""),
  date: z.coerce.date(),
  batch_id: z.string().optional().default(""),
  section_id: z.string().optional().default(""),
  all_day: z.boolean().optional().default(true),
  time: z.string().regex(TIME_HHMM_RE, "time must be HH:mm").optional().or(z.literal("")).default(""),
  duration_minutes: z.coerce.number().int().min(1).max(1440).optional().default(60),
  meet_link: z.string().optional().default(""),
};

/** Holidays are never scheduled items: force all-day, strip time/duration/meet link regardless of input. */
function normalizeEventScheduling(body) {
  if (body.type === "holiday") {
    return { ...body, all_day: true, time: "", meet_link: "" };
  }
  if (body.all_day) {
    return { ...body, time: "", meet_link: body.meet_link || "" };
  }
  if (!body.time) {
    throw Object.assign(new Error("time is required for a specific-time event"), { status: 400, code: "TIME_REQUIRED" });
  }
  return body;
}

/** Minutes until a TimetableEvent starts (timed events only). All-day → null. */
function minutesUntilEventStart(event, at = new Date()) {
  if (!event || event.all_day !== false) return null;
  const dateYmd = formatDateYmdInClassTimeZone(event.date);
  if (!dateYmd) return null;
  const startsAt = parseSlotStart(dateYmd, event.time);
  if (!startsAt) return null;
  return Math.round((startsAt.getTime() - at.getTime()) / 60_000);
}

/**
 * Notify students about TimetableEvent create/update/delete.
 * Holidays are informational-only (no notifications). Far-future create/update suppressed
 * by SCHEDULE_NOTICE_MAX_HOURS_AHEAD (same as classes).
 */
async function handleStudentEventNotifications(event, action) {
  if (!event) return;
  const type = String(event.type || "").toLowerCase();
  if (type === "holiday") return;

  const batchId = String(event.batch_id || "").trim().toLowerCase();
  // Empty batch_id = all batches — skip fan-out to avoid notifying the entire school.
  if (!batchId) return;

  if (action !== "deleted") {
    const mins = minutesUntilEventStart(event);
    // All-day non-holiday events: only notify if within the notice window based on calendar day start.
    if (event.all_day !== false) {
      const dateYmd = formatDateYmdInClassTimeZone(event.date);
      if (!dateYmd) return;
      const dayStart = parseSlotStart(dateYmd, "00:00");
      if (!dayStart) return;
      const minsToDay = Math.round((dayStart.getTime() - Date.now()) / 60_000);
      if (minsToDay > SCHEDULE_NOTICE_MAX_HOURS_AHEAD * 60) return;
    } else if (mins !== null && mins > SCHEDULE_NOTICE_MAX_HOURS_AHEAD * 60) {
      return;
    } else if (mins !== null && mins <= 0) {
      return;
    }
  }

  const sectionId = String(event.section_id || "").trim().toLowerCase();
  const filter = await studentsInBatchesFilterResolved([batchId], {
    sectionId: sectionId || undefined,
  });
  const students = await Student.find(filter).select("_id").lean();
  if (!students.length) return;

  const eventId = String(event._id || event.id || "");
  const when =
    event.all_day !== false
      ? new Date(event.date).toLocaleDateString()
      : `${new Date(event.date).toLocaleDateString()} at ${event.time || ""}`.trim();
  const title =
    action === "deleted"
      ? "Event cancelled"
      : action === "updated"
        ? "Event updated"
        : "New event scheduled";
  const body =
    action === "deleted"
      ? `${event.title} (${when}) was cancelled.`
      : action === "updated"
        ? `${event.title} was updated (${when}).`
        : `${event.title} is scheduled for ${when}.`;
  const dedupeAction = action === "deleted" ? "cancelled" : action;
  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title,
    body,
    read_at: null,
    ref_id: `timetable-event:${eventId}`,
    deep_link: "/timetable",
    meet_url: String(event.meet_link || "").trim(),
    dedupe_key:
      action === "updated"
        ? `timetableEvent:updated:${eventId}:${String(s._id)}:${formatDateYmdInClassTimeZone(event.date)}:${event.time || ""}`
        : `timetableEvent:${dedupeAction}:${eventId}:${String(s._id)}`,
  }));
  const { insertNotificationsIgnoringDuplicates } = require("../services/mentor-notification.service");
  await insertNotificationsIgnoringDuplicates(docs);
}

async function createTimetableEvent(req, res) {
  const schema = z.object(timetableEventFieldsSchema);
  let body;
  try {
    body = normalizeEventScheduling(schema.parse(req.body));
  } catch (e) {
    if (e?.status === 400) return sendError(res, 400, e.code || "INVALID_EVENT", e.message);
    throw e;
  }
  const created = await TimetableEvent.create({
    ...body,
    batch_id: (body.batch_id || "").toLowerCase().trim(),
    section_id: (body.section_id || "").toLowerCase().trim(),
  });
  try {
    await handleStudentEventNotifications(created.toObject(), "created");
  } catch (e) {
    console.error("[EVENT_NOTIFY_CREATE_FAILED]", e?.message || e);
  }
  return sendSuccess(res, { id: String(created._id), ...created.toObject() }, "Created");
}

async function updateTimetableEvent(req, res) {
  const schema = z.object({
    title: z.string().min(1).trim().optional(),
    type: z.enum(TimetableEvent.EVENT_TYPES).optional(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    batch_id: z.string().optional(),
    section_id: z.string().optional(),
    all_day: z.boolean().optional(),
    time: z.string().regex(TIME_HHMM_RE, "time must be HH:mm").optional().or(z.literal("")),
    duration_minutes: z.coerce.number().int().min(1).max(1440).optional(),
    meet_link: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const doc = await TimetableEvent.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Event not found");

  // Re-validate scheduling against the merged (existing + incoming) state so a partial PATCH can't
  // leave a non-holiday event with all_day=false and no time, or leave a holiday with a stale time.
  let merged;
  try {
    merged = normalizeEventScheduling({
      type: body.type ?? doc.type,
      all_day: body.all_day ?? doc.all_day,
      time: body.time ?? doc.time,
      meet_link: body.meet_link ?? doc.meet_link,
    });
  } catch (e) {
    if (e?.status === 400) return sendError(res, 400, e.code || "INVALID_EVENT", e.message);
    throw e;
  }

  Object.assign(doc, body, { all_day: merged.all_day, time: merged.time, meet_link: merged.meet_link });
  if (body.batch_id !== undefined) doc.batch_id = (body.batch_id || "").toLowerCase().trim();
  if (body.section_id !== undefined) doc.section_id = (body.section_id || "").toLowerCase().trim();
  // Date/time change → allow a fresh 15m reminder.
  if (body.date !== undefined || body.time !== undefined || body.all_day !== undefined) {
    doc.reminder_15m_sent_at = null;
  }
  await doc.save();
  try {
    await handleStudentEventNotifications(doc.toObject(), "updated");
  } catch (e) {
    console.error("[EVENT_NOTIFY_UPDATE_FAILED]", e?.message || e);
  }
  return sendSuccess(res, { id: String(doc._id), ...doc.toObject() }, "Updated");
}

async function deleteTimetableEvent(req, res) {
  const doc = await TimetableEvent.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Event not found");
  const r = await TimetableEvent.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Event not found");
  try {
    await handleStudentEventNotifications(doc, "deleted");
  } catch (e) {
    console.error("[EVENT_NOTIFY_DELETE_FAILED]", e?.message || e);
  }
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

/** —— Mentor slots —— */
async function listMentorSlotsAdmin(req, res) {
  const { page, limit, skip } = paginate(req);
  const batch_id = String(req.query.batch_id || "").trim().toLowerCase();
  const section_id = String(req.query.section_id || "").trim().toLowerCase();
  const month = Number(req.query.month || 0);
  let year = Number(req.query.year || 0);
  if (month >= 1 && month <= 12 && !(year >= 1900 && year <= 9999)) {
    year = new Date().getFullYear();
  }
  const filter = {};
  if (batch_id) filter.target_batch_ids = batch_id;
  // Empty target_section_ids on a mentor slot means "whole batch", so a section-scoped query still matches it.
  if (section_id) {
    filter.$or = [
      { target_section_ids: { $size: 0 } },
      { target_section_ids: { $exists: false } },
      { target_section_ids: section_id },
    ];
  }

  // `date` is a real timestamp (unlike TimetableSlot.class_date, a plain YYYY-MM-DD string), so a
  // month filter has to be evaluated in the class's timezone rather than as a naive UTC regex/range
  // — otherwise a late-evening IST session near month-end could get bucketed into the wrong month.
  let items;
  let total;
  if (year >= 1900) {
    const prefix = month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}` : `${String(year)}-`;
    const all = await MentorSlot.find(filter).sort({ date: 1 }).lean();
    const matched = all.filter((m) => formatDateYmdInClassTimeZone(m.date).startsWith(prefix));
    total = matched.length;
    items = matched.slice(skip, skip + limit);
  } else {
    [items, total] = await Promise.all([
      MentorSlot.find(filter).sort({ date: 1 }).skip(skip).limit(limit).lean(),
      MentorSlot.countDocuments(filter),
    ]);
  }
  return sendSuccess(
    res,
    items.map((m) => ({
      id: String(m._id),
      subject: m.subject,
      mentor_name: m.mentor_name,
      staff_id: m.staff_id ? String(m.staff_id) : null,
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

/**
 * Mentor self-service: read-only list of the caller's OWN sessions (matched by mentor_name,
 * same identity match used by the reminder scheduler / notifications). No CRUD — mirrors the
 * read-only instructor timetable pattern.
 */
async function listMentorSlotsMine(req, res) {
  const ownName = await resolveStaffDisplayName(req);
  if (!ownName) return sendSuccess(res, []);

  const schema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });
  const query = schema.parse(req.query);
  const now = new Date();
  const fromDefault = new Date(now);
  fromDefault.setDate(fromDefault.getDate() - 30);
  const toDefault = new Date(now);
  toDefault.setDate(toDefault.getDate() + 120);
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : fromDefault;
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : toDefault;

  const filter = {
    mentor_name: { $regex: new RegExp(`^${escapeRegex(ownName)}$`, "i") },
    date: { $gte: from, $lte: to },
  };
  const items = await MentorSlot.find(filter).sort({ date: 1 }).limit(300).lean();
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
      meet_link: m.meet_link || "",
      target_batch_ids: Array.isArray(m.target_batch_ids) ? m.target_batch_ids : [],
      target_section_ids: Array.isArray(m.target_section_ids) ? m.target_section_ids : [],
      target_student_count: Array.isArray(m.target_student_ids) ? m.target_student_ids.length : 0,
    }))
  );
}

async function getMentorSlot(req, res) {
  const doc = await MentorSlot.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Mentor slot not found");
  return sendSuccess(res, {
    id: String(doc._id),
    ...doc,
    mentor_info: doc.mentor_info || "",
    staff_id: doc.staff_id ? String(doc.staff_id) : null,
    publish_date: doc.publish_date || null,
    duration_minutes: Number(doc.duration_minutes || 60),
    target_batch_ids: Array.isArray(doc.target_batch_ids) ? doc.target_batch_ids : [],
    target_section_ids: Array.isArray(doc.target_section_ids) ? doc.target_section_ids : [],
    target_student_ids: Array.isArray(doc.target_student_ids) ? doc.target_student_ids.map((id) => String(id)) : [],
    booked_by: doc.booked_by ? String(doc.booked_by) : null,
  });
}

/** Eligibility check used only when *accepting a newly supplied* staff_id (create, or a PATCH that changes it). */
async function findEligibleMentorStaff(staffId) {
  if (!staffId || !mongoose.isValidObjectId(String(staffId))) return null;
  return Staff.findOne({
    _id: staffId,
    role: { $in: ["mentor", "instructor"] },
    is_active: true,
  })
    .select("_id name")
    .lean();
}

/**
 * Unrestricted-by-role/active lookup, used only to keep `mentor_name` in sync with a staff_id that
 * is *already committed* on a slot. Deliberately does not require is_active/role — a mentor who
 * later goes inactive (or changes role) shouldn't cause the slot's display name to silently revert
 * to client-supplied free text; the identity stays anchored to the real Staff record either way.
 */
async function findStaffNameById(staffId) {
  if (!staffId || !mongoose.isValidObjectId(String(staffId))) return null;
  return Staff.findOne({ _id: staffId }).select("_id name").lean();
}

/**
 * Keeps `doc.mentor_name` in sync with an already-linked `staff_id` without re-validating that
 * Staff's current active/role eligibility — eligibility is a notification-delivery-time concern
 * (see mentor-notification.service.js:resolveMentorRecipients), not an edit-time gate, so a mentor
 * going inactive must not block unrelated edits to their existing slots. Also ignores (and logs,
 * for follow-up) any client-supplied `mentor_name` that disagrees with the authoritative Staff
 * record, rather than letting it silently win and re-create the exact stale-id/wrong-name bug
 * this resolver exists to prevent.
 */
async function resyncMentorNameFromLinkedStaff(doc, body) {
  const linked = await findStaffNameById(doc.staff_id);
  if (linked) {
    if (body.mentor_name !== undefined && String(body.mentor_name).trim() !== linked.name) {
      console.warn("[MENTOR_SLOT_UPDATE] ignoring client-supplied mentor_name while staff_id is set", {
        slot_id: String(doc._id),
        staff_id: String(doc.staff_id),
        attempted_mentor_name: body.mentor_name,
        authoritative_name: linked.name,
      });
    }
    doc.mentor_name = linked.name;
  } else if (body.mentor_name !== undefined) {
    // Linked Staff doc no longer exists at all (hard-deleted, not just deactivated) — fall back
    // to treating mentor_name as free text rather than blocking an otherwise-unrelated update.
    doc.mentor_name = body.mentor_name;
  }
}

/**
 * Validates an optional mentor-slot `staff_id`: when provided, it must reference an active Staff
 * record eligible to receive mentor-slot notifications (role mentor or instructor). The client-
 * supplied `mentor_name` is never trusted as proof of identity — only this id is.
 * Returns { ok: true, value: "" | validatedStaffIdString, name?: string }, or sends a 400 and
 * returns { ok: false }.
 */
async function resolveMentorStaffIdOrError(res, rawStaffId) {
  const staffId = String(rawStaffId || "").trim();
  if (!staffId) return { ok: true, value: "" };
  if (!mongoose.isValidObjectId(staffId)) {
    sendError(res, 400, "VALIDATION_ERROR", "staff_id must be a valid staff id");
    return { ok: false };
  }
  const staff = await findEligibleMentorStaff(staffId);
  if (!staff) {
    sendError(res, 400, "VALIDATION_ERROR", "staff_id must reference an active mentor or instructor");
    return { ok: false };
  }
  return { ok: true, value: staffId, name: staff.name };
}

async function createMentorSlot(req, res) {
  const schema = z.object({
    mentor_name: z.string().min(1).trim(),
    staff_id: z.string().trim().optional().default(""),
    mentor_info: z.string().trim().optional().default(""),
    date: z.coerce.date(),
    publish_date: z.coerce.date().optional(),
    time: z.string().min(1).trim(),
    duration_minutes: z.coerce.number().int().min(1).max(600).optional().default(60),
    meet_link: zGoogleMeetUrlRequired(),
    target_batch_ids: z.array(z.string().trim().toLowerCase()).optional().default([]),
    target_section_ids: z.array(z.string().trim().toLowerCase()).optional().default([]),
    target_student_ids: z.array(z.string().trim()).optional().default([]),
    booking_state: z.enum(["open", "booked", "cancelled"]).optional(),
  });
  const body = schema.parse(req.body);
  if (new Date(body.date).getTime() <= Date.now()) {
    return sendError(res, 400, "VALIDATION_ERROR", "Session date must be in the future");
  }
  const staffIdCheck = await resolveMentorStaffIdOrError(res, body.staff_id);
  if (!staffIdCheck.ok) return;
  const targetStudentIds = body.target_student_ids.filter((id) => mongoose.isValidObjectId(id));
  const targetBatchIds = [...new Set(body.target_batch_ids.filter(Boolean))];
  const targetSectionIds = [...new Set(body.target_section_ids.filter(Boolean))];
  const slotPayload = {
    subject: "Mentor Session",
    // Identity invariant: once staff_id resolves, mentor_name is derived from that Staff record —
    // never trusted independently from the client, so the two fields can never disagree.
    mentor_name: staffIdCheck.value ? staffIdCheck.name : body.mentor_name,
    staff_id: staffIdCheck.value || null,
    mentor_info: body.mentor_info || "",
    date: body.date,
    publish_date: body.publish_date || new Date(),
    time: body.time,
    duration_minutes: body.duration_minutes || 60,
    meet_link: parseGoogleMeetUrl(body.meet_link) || body.meet_link.trim(),
    target_batch_ids: targetBatchIds,
    target_section_ids: targetSectionIds,
    target_student_ids: targetStudentIds,
    booking_state: body.booking_state || "open",
    booked_by: null,
    booked_at: null,
  };
  initMentorLifecycleFieldsOnCreate(slotPayload);
  const created = await MentorSlot.create(slotPayload);
  const slotObj = created.toObject();
  if (!body.publish_date || new Date(body.publish_date).getTime() <= Date.now()) {
    await fanoutMentorSlotNotification(slotObj);
    try {
      await handleMentorLifecycleOnPublish(slotObj);
    } catch (err) {
      console.error("[MENTOR_LIFECYCLE_ON_CREATE_PUBLISH_FAILED]", err?.message || err);
    }
  }
  return sendSuccess(res, { id: String(created._id), ...slotObj }, "Created");
}

async function updateMentorSlot(req, res) {
  const schema = z.object({
    mentor_name: z.string().optional(),
    staff_id: z.string().trim().optional(),
    mentor_info: z.string().optional(),
    date: z.coerce.date().optional(),
    publish_date: z.coerce.date().optional(),
    time: z.string().optional(),
    duration_minutes: z.coerce.number().int().min(1).max(600).optional(),
    meet_link: zGoogleMeetUrlPatch(),
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
  const prevDate = doc.date;
  const prevTime = String(doc.time || "").trim();
  const prevStaffId = doc.staff_id ? String(doc.staff_id) : "";
  const prevMentorName = String(doc.mentor_name || "").trim();
  const prevMeetLink = String(doc.meet_link || "").trim();
  const prevBookingState = doc.booking_state;
  const wasPublished = doc.publish_date ? new Date(doc.publish_date).getTime() <= Date.now() : true;
  // Identity invariant (monotonic): legacy (staff_id == null) -> linked is allowed; linked ->
  // a *different* linked staff member is allowed; linked -> legacy/null is NOT allowed through
  // this API (no existing UI/product flow unlinks a mentor slot — see resolveMentorStaffIdOrError
  // caller below). Whenever staff_id is (or remains) set, mentor_name is derived from that Staff
  // record — a client-supplied mentor_name can never combine with a stale/unrelated staff_id to
  // persist contradictory identity (e.g. staff_id=Alice, mentor_name=Bob). mentor_name is only
  // independently editable while staff_id has never been set (the legacy free-text case).
  if (body.staff_id !== undefined) {
    const requestedStaffId = String(body.staff_id || "").trim();
    const currentStaffId = doc.staff_id ? String(doc.staff_id) : "";

    if (!requestedStaffId) {
      if (currentStaffId) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "staff_id cannot be cleared once a mentor slot is linked to a staff record"
        );
      }
      // Already unlinked and staying that way — mentor_name remains plain free text.
      if (body.mentor_name !== undefined) doc.mentor_name = body.mentor_name;
    } else if (requestedStaffId === currentStaffId) {
      // Re-affirming the *same* already-linked mentor — this is what a full-form save (e.g. the
      // admin UI) does on every edit, including ones that touch unrelated fields only. This must
      // NOT re-run the strict active/role eligibility check, or an unrelated edit (e.g. changing
      // duration_minutes) would start failing the moment that mentor goes inactive. Eligibility
      // for notification delivery is a separate, later concern — see resolveMentorRecipients.
      await resyncMentorNameFromLinkedStaff(doc, body);
    } else {
      // Genuinely assigning a *different* mentor — a real identity change, so validate strictly
      // (must be an active, eligible Staff record). Resolves to exactly one id, no fan-out risk.
      const staffIdCheck = await resolveMentorStaffIdOrError(res, requestedStaffId);
      if (!staffIdCheck.ok) return;
      doc.staff_id = staffIdCheck.value;
      doc.mentor_name = staffIdCheck.name;
    }
  } else if (doc.staff_id) {
    // staff_id wasn't part of this patch at all (e.g. a raw partial-PATCH caller) but the slot is
    // already linked — same "keep in sync, don't re-validate eligibility" treatment as above.
    await resyncMentorNameFromLinkedStaff(doc, body);
  } else if (body.mentor_name !== undefined) {
    // No staff_id involved at all (legacy slot, never linked) — mentor_name is plain free text.
    doc.mentor_name = body.mentor_name;
  }
  if (body.mentor_info !== undefined) doc.mentor_info = body.mentor_info;
  if (body.date !== undefined) doc.date = body.date;
  if (body.publish_date !== undefined) doc.publish_date = body.publish_date;
  if (body.time !== undefined) doc.time = body.time;
  if (body.duration_minutes !== undefined) doc.duration_minutes = body.duration_minutes;
  if (body.meet_link !== undefined) {
    doc.meet_link = parseGoogleMeetUrl(body.meet_link) || body.meet_link.trim();
  }
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

  const nextStaffId = doc.staff_id ? String(doc.staff_id) : "";
  const nextMentorName = String(doc.mentor_name || "").trim();
  const nextMeetLink = String(doc.meet_link || "").trim();
  const scheduleChanged = mentorScheduleChanged(prevDate, prevTime, doc.date, doc.time);
  const mentorChanged = mentorIdentityChanged(prevStaffId, prevMentorName, nextStaffId, nextMentorName);
  const meetChanged = mentorMeetLinkChanged(prevMeetLink, nextMeetLink);
  const isPublishedNow = doc.publish_date ? new Date(doc.publish_date).getTime() <= Date.now() : true;
  const becamePublished = !wasPublished && isPublishedNow;
  const becameCancelled = prevBookingState !== "cancelled" && doc.booking_state === "cancelled";

  if (scheduleChanged) {
    doc.schedule_revision = (Number(doc.schedule_revision) || 1) + 1;
    resetMentorScheduleReminderMarkers(doc);
  }
  if (mentorChanged) {
    doc.mentor_assignment_revision = (Number(doc.mentor_assignment_revision) || 1) + 1;
    if (!scheduleChanged) resetMentorOnlyReminderMarkers(doc);
  }
  if (meetChanged && !scheduleChanged && !mentorChanged) {
    doc.meet_link_revision = (Number(doc.meet_link_revision) || 1) + 1;
  }
  if (scheduleChanged || mentorChanged || becamePublished) {
    applyMentor60mSuppression(doc);
  }

  await doc.save();
  const snapshot = doc.toObject();

  if (becameCancelled) {
    try {
      await notifyMentorSlotCancelled(snapshot);
    } catch (err) {
      console.error("[MENTOR_SLOT_CANCELLED_NOTIFY_FAILED]", err?.message || err);
    }
  } else {
    if (becamePublished) {
      await fanoutMentorSlotNotification(snapshot);
    }
    try {
      await handleMentorLifecycleAfterUpdate({
        slot: snapshot,
        becamePublished,
        becameCancelled: false,
        scheduleChanged,
        mentorChanged,
        meetLinkChanged: meetChanged,
        previousSchedule: scheduleChanged ? { date: prevDate, time: prevTime } : undefined,
        previousMentor: mentorChanged
          ? { staff_id: prevStaffId || null, mentor_name: prevMentorName }
          : undefined,
      });
    } catch (err) {
      console.error("[MENTOR_LIFECYCLE_UPDATE_FAILED]", err?.message || err);
    }
  }

  return sendSuccess(res, { id: String(doc._id), ...snapshot }, "Updated");
}

async function googleMeetCalendarStatus(req, res) {
  return sendSuccess(res, {
    configured: googleMeetCal.isGoogleMeetCalendarConfigured(),
  });
}

/** Active instructor eligible for Meet calendar invites (id-based resolution). */
async function findEligibleInstructorStaff(staffId) {
  if (!staffId || !mongoose.isValidObjectId(String(staffId))) return null;
  return Staff.findOne({
    _id: staffId,
    role: ROLES.INSTRUCTOR,
    is_active: true,
  })
    .select("_id name email")
    .lean();
}

/**
 * Resolves the instructor for Meet provisioning. When `staff_id` is supplied it is authoritative —
 * invalid/inactive/wrong-role ids error out and never fall back to `teacher` name. Without `staff_id`,
 * legacy name matching is ambiguity-safe (0 → omit, 1 → use, 2+ → omit + ambiguous).
 * @returns {Promise<
 *   | { ok: true, displayName: string, email: string, resolution: "staff_id" | "name" | "none" | "ambiguous", resolutionMessage?: string }
 *   | { ok: false, status: number, code: string, message: string }
 * >}
 */
async function resolveMeetProvisionInstructor({ staffId, teacherName }) {
  const sid = String(staffId || "").trim();
  if (sid) {
    if (!mongoose.isValidObjectId(sid)) {
      return { ok: false, status: 400, code: "VALIDATION_ERROR", message: "staff_id must be a valid staff id" };
    }
    const staff = await findEligibleInstructorStaff(sid);
    if (!staff) {
      return {
        ok: false,
        status: 400,
        code: "VALIDATION_ERROR",
        message: "staff_id must reference an active instructor",
      };
    }
    const displayName = String(staff.name || "").trim();
    const email = String(staff.email || "").includes("@")
      ? String(staff.email).trim().toLowerCase()
      : "";
    return { ok: true, displayName, email, resolution: "staff_id" };
  }

  const nameTrim = String(teacherName || "").trim();
  if (!nameTrim) {
    return { ok: true, displayName: "", email: "", resolution: "none" };
  }

  const instructors = await Staff.find({ role: ROLES.INSTRUCTOR, is_active: true }).select("name email").lean();
  const matches = instructors.filter(
    (row) => String(row.name || "").trim().toLowerCase() === nameTrim.toLowerCase()
  );
  if (matches.length === 0) {
    return { ok: true, displayName: nameTrim, email: "", resolution: "none" };
  }
  if (matches.length > 1) {
    return {
      ok: true,
      displayName: nameTrim,
      email: "",
      resolution: "ambiguous",
      resolutionMessage:
        "Multiple active instructors share this name; select the instructor from the team list.",
    };
  }

  const only = matches[0];
  const email = String(only.email || "").includes("@") ? String(only.email).trim().toLowerCase() : "";
  return {
    ok: true,
    displayName: String(only.name || "").trim() || nameTrim,
    email,
    resolution: "name",
  };
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
    staff_id: z.string().trim().optional().default(""),
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

  const instructorResolved = await resolveMeetProvisionInstructor({
    staffId: body.staff_id,
    teacherName: body.teacher,
  });
  if (!instructorResolved.ok) {
    return sendError(res, instructorResolved.status, instructorResolved.code, instructorResolved.message);
  }

  const filter = await catalogBatchStudentFilterResolved(body.batch_id.toLowerCase(), body.section_id);
  const students = await Student.find(filter).select("email").lean().limit(5000);
  const studentEmails = [
    ...new Set(students.map((s) => String(s.email || "").trim().toLowerCase()).filter(Boolean)),
  ];

  const teacherNameTrim = instructorResolved.displayName || body.teacher.trim();
  const teacherEmail = instructorResolved.email;

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
        instructor_resolution: instructorResolved.resolution,
        ...(instructorResolved.resolutionMessage
          ? { instructor_resolution_message: instructorResolved.resolutionMessage }
          : {}),
      },
      "Meet link created and calendar invites sent."
    );
  } catch (e) {
    console.error("[PROVISION_TIMETABLE_GOOGLE_MEET]", e?.message || e);
    return sendError(res, 502, "GOOGLE_MEET_FAILED", String(e.message || "Failed to create Meet"));
  }
}

async function deleteMentorSlot(req, res) {
  const doc = await MentorSlot.findById(req.params.id).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Mentor slot not found");
  const r = await MentorSlot.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Mentor slot not found");
  // Previously deleting a mentor slot notified nobody at all — neither the targeted students
  // nor the mentor who may have already been told (and emailed) about the original session.
  try {
    await notifyMentorSlotCancelled(doc);
  } catch (e) {
    console.error("[MENTOR_SLOT_CANCELLED_NOTIFY_FAILED]", e?.message || e);
  }
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

module.exports = {
  listAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  publishProjectAssignment,
  unpublishProjectAssignment,
  listAssignmentQuestions,
  createAssignmentQuestion,
  getAssignmentQuestion,
  updateAssignmentQuestion,
  deleteAssignmentQuestion,
  verifyWebChecks,
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
  listMentorSlotsMine,
  getMentorSlot,
  createMentorSlot,
  updateMentorSlot,
  deleteMentorSlot,
};
