const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");
const { COURSE_CATEGORIES, BILLING_MODES } = Course;

const baseSchema = z.object({
  code: z.string().min(1).max(80).trim().toLowerCase(),
  name: z.string().min(1).max(200).trim(),
  category: z.enum(COURSE_CATEGORIES).default("specialization"),
  description: z.string().max(4000).optional().default(""),
  duration_months: z.number().int().min(0).max(120).nullable().optional(),
  billing_mode: z.enum(BILLING_MODES).default("monthly"),
  base_fee_paise: z.number().int().min(0),
  starts_on: z.coerce.date().nullable().optional(),
  ends_on: z.coerce.date().nullable().optional(),
  is_active: z.boolean().optional().default(true),
  linked_batch_id: z.string().max(80).trim().toLowerCase().optional().default(""),
});

const patchSchema = baseSchema.partial();

function toRow(c) {
  return {
    id: String(c._id),
    code: c.code,
    name: c.name,
    category: c.category,
    description: c.description || "",
    duration_months: c.duration_months ?? null,
    billing_mode: c.billing_mode,
    base_fee_paise: c.base_fee_paise,
    starts_on: c.starts_on,
    ends_on: c.ends_on,
    is_active: c.is_active,
    linked_batch_id: c.linked_batch_id || "",
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/** One active Course per batch: returns a clashing active course (excluding `exceptId`) or null. */
async function batchAlreadyHasActiveCourse(linkedBatchId, exceptId) {
  const bid = String(linkedBatchId || "").toLowerCase().trim();
  if (!bid) return null;
  const q = { linked_batch_id: bid, is_active: true };
  if (exceptId) q._id = { $ne: exceptId };
  return Course.findOne(q).select("_id code name").lean();
}

async function listCourses(req, res) {
  const { category, is_active, q } = req.query || {};
  const filter = {};
  if (category) filter.category = String(category);
  if (typeof is_active !== "undefined") filter.is_active = is_active === "true" || is_active === true;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { code: rx }];
  }
  const rows = await Course.find(filter).sort({ is_active: -1, category: 1, name: 1 }).limit(500).lean();
  return sendSuccess(res, rows.map(toRow));
}

async function getCourse(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const c = await Course.findById(id).lean();
  if (!c) return sendError(res, 404, "NOT_FOUND", "Course not found");
  return sendSuccess(res, toRow(c));
}

async function createCourse(req, res) {
  const parsed = baseSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const body = parsed.data;
  if (body.is_active !== false && body.linked_batch_id) {
    const clash = await batchAlreadyHasActiveCourse(body.linked_batch_id, null);
    if (clash) {
      return sendError(res, 409, "BATCH_HAS_ACTIVE_COURSE", `Batch "${body.linked_batch_id}" is already linked to active course "${clash.code}". A batch may have only one active course.`);
    }
  }
  try {
    const doc = await Course.create({
      ...body,
      created_by: req.staff?.sub,
      updated_by: req.staff?.sub,
    });
    return sendSuccess(res, toRow(doc.toObject()), "Course created");
  } catch (err) {
    if (err.code === 11000) return sendError(res, 409, "DUPLICATE", "Course code already exists");
    return sendError(res, 500, "CREATE_FAILED", err.message);
  }
}

async function updateCourse(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const doc = await Course.findById(id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Course not found");
  const prevLinkedBatchId = String(doc.linked_batch_id || "").toLowerCase().trim();
  Object.assign(doc, parsed.data);
  doc.updated_by = req.staff?.sub;
  // Decision #11: forbid re-linking a course to a different batch once it has active enrollments —
  // re-pointing would strand historical invoices/scorecard on the old batch. Archive + recreate instead.
  if (String(doc.linked_batch_id || "").toLowerCase().trim() !== prevLinkedBatchId) {
    const activeEnr = await StudentEnrollment.countDocuments({ course_id: doc._id, status: "active" });
    if (activeEnr > 0) {
      return sendError(
        res,
        409,
        "COURSE_RELINK_BLOCKED",
        `Cannot change this course's batch: ${activeEnr} active enrollment(s) exist. Archive this course and create a new one for the other batch.`
      );
    }
  }
  if (doc.is_active && String(doc.linked_batch_id || "").trim()) {
    const clash = await batchAlreadyHasActiveCourse(doc.linked_batch_id, doc._id);
    if (clash) {
      return sendError(res, 409, "BATCH_HAS_ACTIVE_COURSE", `Batch "${doc.linked_batch_id}" is already linked to active course "${clash.code}". A batch may have only one active course.`);
    }
  }
  try {
    await doc.save();
    // Keep the denormalized StudentEnrollment.batch_id in sync if this course's batch changed.
    const nextLinkedBatchId = String(doc.linked_batch_id || "").toLowerCase().trim();
    if (nextLinkedBatchId !== prevLinkedBatchId) {
      await StudentEnrollment.updateMany(
        { course_id: doc._id },
        { $set: { batch_id: nextLinkedBatchId } }
      );
    }
    return sendSuccess(res, toRow(doc.toObject()), "Course updated");
  } catch (err) {
    if (err.code === 11000) return sendError(res, 409, "DUPLICATE", "Course code already exists");
    return sendError(res, 500, "UPDATE_FAILED", err.message);
  }
}

async function deleteCourse(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  // If enrollments exist, soft-delete via is_active=false to preserve referential history.
  const enrolled = await StudentEnrollment.countDocuments({ course_id: id });
  if (enrolled > 0) {
    await Course.updateOne({ _id: id }, { $set: { is_active: false, updated_by: req.staff?.sub } });
    return sendSuccess(res, { id, soft_deleted: true }, "Course archived (has enrollments)");
  }
  const r = await Course.deleteOne({ _id: id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Course not found");
  return sendSuccess(res, { id }, "Course deleted");
}

module.exports = { listCourses, getCourse, createCourse, updateCourse, deleteCourse };
