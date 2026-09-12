const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const BatchCatalog = require("../models/BatchCatalog");
const Course = require("../models/Course");
const Student = require("../models/Student");
const Assignment = require("../models/Assignment");
const { assignmentVisibleToCatalogBatchCountFilter } = require("../utils/assignmentBatchFilter");
const { DEFAULT_BATCHES, DEFAULT_SECTIONS_BY_BATCH } = require("../constants/batchDefaults");
const { catalogBatchMongoMatch, augmentStudentCatalogFieldsFromEnrollment, catalogBatchStudentFilter } = require("../utils/enrollment");
const { catalogBatchMongoMatchResolved, catalogBatchStudentFilterResolved } = require("../utils/student-batch-context");
const { getInstructorAssignedBatchIds } = require("../utils/instructorBatchScope");
const registry = require("../utils/batch-catalog-registry");
const {
  GOOGLE_DRIVE_FOLDER_URL_MESSAGE,
  normalizeGoogleDriveFolderUrlInput,
  zGoogleDriveFolderUrlCreate,
  zGoogleDriveFolderUrlPatch,
} = require("../utils/google-drive-folder-url");

function normCatalogSectionId(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

async function ensureDefaultBatches() {
  for (const d of DEFAULT_BATCHES) {
    await BatchCatalog.updateOne(
      { batch_id: d.batch_id },
      {
        $setOnInsert: {
          name: d.name,
          order: d.order,
          sections: [],
          enrollment_prefix: d.enrollment_prefix || "",
          tier_label: d.tier_label || "",
          is_protected: d.is_protected === true,
          is_active: true,
          include_in_default_views: d.include_in_default_views !== false,
        },
      },
      { upsert: true }
    );
  }
  for (const [batch_id, sections] of Object.entries(DEFAULT_SECTIONS_BY_BATCH)) {
    await BatchCatalog.updateOne(
      { batch_id, $or: [{ sections: { $exists: false } }, { sections: { $size: 0 } }] },
      { $set: { sections } }
    );
  }
  await stripLegacyCoreDummySections();
}

/** Remove old placeholder “core” section from fixed batches (subjects must be re-added to real sections in admin). */
async function stripLegacyCoreDummySections() {
  for (const d of DEFAULT_BATCHES) {
    const batch_id = d.batch_id;
    const doc = await BatchCatalog.findOne({ batch_id }).lean();
    if (!doc?.sections?.length) continue;
    const next = doc.sections.filter((s) => normCatalogSectionId(s.section_id) !== "core");
    if (next.length === doc.sections.length) continue;
    await BatchCatalog.updateOne({ batch_id }, { $set: { sections: next } });
  }
}

const sectionSchema = z.object({
  section_id: z.string().min(1).trim(),
  name: z.string().min(1).trim(),
  subjects: z.array(z.string().trim()).default([]),
});

const createBody = z.object({
  batch_id: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "batch_id: use lowercase letters, numbers, hyphens only"),
  name: z.string().min(1).trim(),
  order: z.number().int().optional(),
  sections: z.array(sectionSchema).optional().default([]),
  enrollment_prefix: z.string().trim().max(6).optional(),
  tier_label: z.string().trim().max(80).optional(),
  include_in_default_views: z.boolean().optional(),
  recording_drive_folder_url: zGoogleDriveFolderUrlCreate(),
});

const updateBody = z.object({
  name: z.string().min(1).trim().optional(),
  order: z.number().int().optional(),
  sections: z.array(sectionSchema).optional(),
  enrollment_prefix: z.string().trim().max(6).optional(),
  tier_label: z.string().trim().max(80).optional(),
  include_in_default_views: z.boolean().optional(),
  recording_drive_folder_url: zGoogleDriveFolderUrlPatch(),
});

function staffCanViewRecordingDestination(req) {
  const role = String(req.staff?.role || "").trim();
  return role === "super_admin" || role === "admin";
}

/** Validate + normalize an enrollment prefix; ensure no other batch already uses it. */
async function validateUniquePrefix(rawPrefix, exceptBatchId = "") {
  const prefix = String(rawPrefix || "").trim().toUpperCase();
  if (!prefix) return { prefix: "" };
  if (!/^[A-Z]{1,6}$/.test(prefix)) {
    return { error: "enrollment_prefix must be 1–6 letters (e.g. S, B, I, SU, ADV)" };
  }
  // Check the registry seed too — it owns S/B/I even before they're backfilled into the DB,
  // so a new batch can't claim a seeded prefix while the partial-unique DB index can't see it yet.
  const regOwner = registry.prefixToBatchIdSync(prefix);
  if (regOwner && regOwner !== exceptBatchId) {
    return { error: `Enrollment prefix "${prefix}" is already used by batch "${regOwner}"` };
  }
  const clash = await BatchCatalog.findOne({ enrollment_prefix: prefix }).lean();
  if (clash && clash.batch_id !== exceptBatchId) {
    return { error: `Enrollment prefix "${prefix}" is already used by batch "${clash.batch_id}"` };
  }
  return { prefix };
}

function normalizeSections(sections) {
  const seen = new Set();
  const out = [];
  for (const s of sections) {
    const sid = String(s.section_id).trim().toLowerCase().replace(/\s+/g, "-");
    if (seen.has(sid)) {
      throw new Error(`Duplicate section_id: ${sid}`);
    }
    seen.add(sid);
    out.push({
      section_id: sid,
      name: String(s.name).trim(),
      subjects: [...new Set((s.subjects || []).map((x) => String(x).trim()).filter(Boolean))],
    });
  }
  return out;
}

function serialize(doc, { includeRecordingDestination = false } = {}) {
  const o = doc.toObject ? doc.toObject() : doc;
  const base = {
    id: String(o._id),
    batch_id: o.batch_id,
    name: o.name,
    order: o.order ?? 0,
    sections: (o.sections || []).map((s) => ({
      section_id: s.section_id,
      name: s.name,
      subjects: s.subjects || [],
    })),
    // Registry fallback so the three seeded batches show correct values even before backfill.
    enrollment_prefix: o.enrollment_prefix || registry.batchIdToPrefixSync(o.batch_id) || "",
    tier_label: o.tier_label || registry.tierLabelSync(o.batch_id) || "",
    is_protected: o.is_protected !== undefined ? !!o.is_protected : registry.isProtectedSync(o.batch_id),
    is_active: o.is_active !== false,
    include_in_default_views: o.include_in_default_views !== false,
    updatedAt: o.updatedAt,
    createdAt: o.createdAt,
  };
  if (includeRecordingDestination) {
    const recordingUrl = String(o.recording_drive_folder_url || "").trim();
    base.recording_drive_folder_url = recordingUrl;
    base.recording_folder_configured = Boolean(recordingUrl);
  }
  return base;
}

function normalizeRecordingDestinationField(raw) {
  try {
    return normalizeGoogleDriveFolderUrlInput(raw);
  } catch (e) {
    const message = e?.message === GOOGLE_DRIVE_FOLDER_URL_MESSAGE
      ? GOOGLE_DRIVE_FOLDER_URL_MESSAGE
      : GOOGLE_DRIVE_FOLDER_URL_MESSAGE;
    const err = new Error(message);
    err.code = "VALIDATION_ERROR";
    throw err;
  }
}

async function list(req, res) {
  await ensureDefaultBatches();
  const includeRecordingDestination = staffCanViewRecordingDestination(req);
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  const batchQuery =
    instructorBatches !== null
      ? instructorBatches.length
        ? { batch_id: { $in: instructorBatches } }
        : { _id: null }
      : {};
  // Hide soft-retired batches (is_active:false). Existing rows have no is_active field, so
  // `$ne:false` keeps them visible — only explicitly retired batches drop off.
  batchQuery.is_active = { $ne: false };
  const rows = await BatchCatalog.find(batchQuery).sort({ order: 1, name: 1 }).lean();
  const out = await Promise.all(
    rows.map(async (r) => {
      const base = serialize(r, { includeRecordingDestination });
      const filter = { role: "student", ...(await catalogBatchMongoMatchResolved(r.batch_id)) };
      const assignFilter = assignmentVisibleToCatalogBatchCountFilter(r.batch_id);
      const [student_count, assignment_count] = await Promise.all([
        Student.countDocuments(filter),
        assignFilter ? Assignment.countDocuments(assignFilter) : Promise.resolve(0),
      ]);
      return { ...base, student_count, assignment_count };
    })
  );
  return sendSuccess(res, out);
}

/**
 * Students in a program batch (catalog batch_id). Optional section_id filters by catalog assignment
 * or, if unset, by enrollment_section when it matches the catalog section id (e.g. section "01" and ID …01…).
 * use section_id=__unassigned__ for students with no catalog section set.
 */
async function listStudentsInBatch(req, res) {
  const batch_id = String(req.params.batch_id || "").trim().toLowerCase();
  const rawSection = req.query.section_id;
  const filter = await catalogBatchStudentFilterResolved(batch_id, rawSection);

  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const [students, total] = await Promise.all([
    Student.find(filter)
      .select("name email enrollment_number enrollment_section section_id avatar_url")
      .sort({ name: 1 })
      .limit(limit)
      .lean(),
    Student.countDocuments(filter),
  ]);

  const data = students.map((s) => {
    const d = augmentStudentCatalogFieldsFromEnrollment(s);
    return {
      id: String(d._id),
      name: d.name,
      email: d.email,
      enrollment_number: d.enrollment_number || "",
      enrollment_section: d.enrollment_section || "",
      section_id: d.section_id || "",
      avatar_url: d.avatar_url || "",
    };
  });

  return sendSuccess(res, { students: data, total }, "", { total });
}

async function getOne(req, res) {
  const batch_id = String(req.params.batch_id || "").trim().toLowerCase();
  const doc = await BatchCatalog.findOne({ batch_id }).lean();
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Batch not found");
  return sendSuccess(
    res,
    serialize(doc, { includeRecordingDestination: staffCanViewRecordingDestination(req) })
  );
}

async function create(req, res) {
  const body = createBody.parse(req.body);
  const batch_id = body.batch_id.toLowerCase();
  const exists = await BatchCatalog.findOne({ batch_id }).lean();
  if (exists) return sendError(res, 400, "DUPLICATE", "A batch with this batch_id already exists");
  let sections = [];
  try {
    sections = normalizeSections(body.sections || []);
  } catch (e) {
    return sendError(res, 400, "VALIDATION_ERROR", e.message || "Invalid sections");
  }
  const { prefix, error: prefixErr } = await validateUniquePrefix(body.enrollment_prefix);
  if (prefixErr) return sendError(res, 400, "VALIDATION_ERROR", prefixErr);
  let recording_drive_folder_url = "";
  if (body.recording_drive_folder_url !== undefined) {
    try {
      recording_drive_folder_url = normalizeRecordingDestinationField(body.recording_drive_folder_url);
    } catch (e) {
      return sendError(res, 400, "VALIDATION_ERROR", e.message || GOOGLE_DRIVE_FOLDER_URL_MESSAGE);
    }
  }
  const doc = await BatchCatalog.create({
    batch_id,
    name: body.name,
    order: body.order ?? 0,
    sections,
    enrollment_prefix: prefix,
    tier_label: body.tier_label || "",
    is_active: true,
    include_in_default_views: body.include_in_default_views !== false,
    recording_drive_folder_url,
  });
  await registry.refresh(true);

  // Auto-create a placeholder billing Course linked to this batch so it's immediately enrollable.
  // Fee is 0 (the monthly invoice scheduler skips fee <= 0), so no invoices go out until a
  // super-admin sets the real fee in Billing → Courses. Idempotent + best-effort: a failure here
  // (e.g. a stray course already using this code) must never fail the batch creation itself.
  let courseAutocreated = false;
  try {
    const existingCourse = await Course.findOne({ linked_batch_id: batch_id, is_active: true })
      .select("_id")
      .lean();
    if (!existingCourse) {
      await Course.create({
        code: batch_id,
        name: body.name,
        linked_batch_id: batch_id,
        base_fee_paise: 0,
        billing_mode: "monthly",
        category: "specialization",
        is_active: true,
        created_by: req.staff?.sub || null,
        updated_by: req.staff?.sub || null,
      });
      courseAutocreated = true;
    }
  } catch (err) {
    console.warn("[BATCH_COURSE_AUTOCREATE_FAILED]", batch_id, err?.message || err);
  }

  return sendSuccess(
    res,
    serialize(doc, { includeRecordingDestination: true }),
    "Batch created",
    { course_autocreated: courseAutocreated }
  );
}

async function update(req, res) {
  const batch_id = String(req.params.batch_id || "").trim().toLowerCase();
  const body = updateBody.parse(req.body);
  const doc = await BatchCatalog.findOne({ batch_id });
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Batch not found");
  if (body.name !== undefined) doc.name = body.name;
  if (body.order !== undefined) doc.order = body.order;
  if (body.sections !== undefined) {
    try {
      doc.sections = normalizeSections(body.sections);
    } catch (e) {
      return sendError(res, 400, "VALIDATION_ERROR", e.message || "Invalid sections");
    }
  }
  if (body.enrollment_prefix !== undefined) {
    const { prefix, error: prefixErr } = await validateUniquePrefix(body.enrollment_prefix, batch_id);
    if (prefixErr) return sendError(res, 400, "VALIDATION_ERROR", prefixErr);
    doc.enrollment_prefix = prefix;
  }
  if (body.tier_label !== undefined) doc.tier_label = body.tier_label;
  if (body.include_in_default_views !== undefined) doc.include_in_default_views = !!body.include_in_default_views;
  if (body.recording_drive_folder_url !== undefined) {
    try {
      doc.recording_drive_folder_url = normalizeRecordingDestinationField(body.recording_drive_folder_url);
    } catch (e) {
      return sendError(res, 400, "VALIDATION_ERROR", e.message || GOOGLE_DRIVE_FOLDER_URL_MESSAGE);
    }
  }
  await doc.save();
  await registry.refresh(true);
  return sendSuccess(res, serialize(doc, { includeRecordingDestination: true }), "Batch updated");
}

async function remove(req, res) {
  const batch_id = String(req.params.batch_id || "").trim().toLowerCase();
  if (DEFAULT_BATCHES.some((d) => d.batch_id === batch_id) || registry.isProtectedSync(batch_id)) {
    return sendError(res, 400, "FORBIDDEN", "Cannot delete a protected batch (Spark, Builders, Innovators)");
  }
  // Pre-flight: don't strand students. A batch with active members would leave them in a retired
  // batch (still billed, hidden from add/remove). Block unless ?force=1. Checks both the enrollment
  // membership (M:N) and the legacy batch_id/enrollment-letter membership.
  const StudentEnrollment = require("../models/StudentEnrollment");
  const [enrolledActive, legacyMembers] = await Promise.all([
    StudentEnrollment.countDocuments({ batch_id, status: "active" }),
    Student.countDocuments({ role: "student", ...catalogBatchMongoMatch(batch_id) }),
  ]);
  const memberCount = Math.max(enrolledActive, legacyMembers);
  if (memberCount > 0 && String(req.query.force || "") !== "1") {
    return sendError(
      res,
      409,
      "BATCH_HAS_ACTIVE_STUDENTS",
      `~${memberCount} student(s) are still in "${batch_id}". Move/complete them first, or retry with ?force=1.`
    );
  }
  // Soft-retire instead of hard delete: preserve historical data and avoid orphaning
  // enrollments / content that reference this batch_id. Retired batches are hidden from lists.
  const r = await BatchCatalog.updateOne({ batch_id }, { $set: { is_active: false } });
  if (r.matchedCount === 0) return sendError(res, 404, "NOT_FOUND", "Batch not found");
  await registry.refresh(true);
  return sendSuccess(res, {}, "Batch retired");
}

module.exports = { list, getOne, create, update, remove, listStudentsInBatch };
