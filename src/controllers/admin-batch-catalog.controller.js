const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const BatchCatalog = require("../models/BatchCatalog");
const Student = require("../models/Student");
const Assignment = require("../models/Assignment");
const { assignmentVisibleToCatalogBatchCountFilter } = require("../utils/assignmentBatchFilter");
const { DEFAULT_BATCHES, DEFAULT_SECTIONS_BY_BATCH } = require("../constants/batchDefaults");
const { catalogBatchMongoMatch, augmentStudentCatalogFieldsFromEnrollment, catalogBatchStudentFilter } = require("../utils/enrollment");

function normCatalogSectionId(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

async function ensureDefaultBatches() {
  for (const d of DEFAULT_BATCHES) {
    await BatchCatalog.updateOne(
      { batch_id: d.batch_id },
      { $setOnInsert: { name: d.name, order: d.order, sections: [] } },
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
});

const updateBody = z.object({
  name: z.string().min(1).trim().optional(),
  order: z.number().int().optional(),
  sections: z.array(sectionSchema).optional(),
});

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

function serialize(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    batch_id: o.batch_id,
    name: o.name,
    order: o.order ?? 0,
    sections: (o.sections || []).map((s) => ({
      section_id: s.section_id,
      name: s.name,
      subjects: s.subjects || [],
    })),
    updatedAt: o.updatedAt,
    createdAt: o.createdAt,
  };
}

async function list(req, res) {
  await ensureDefaultBatches();
  const rows = await BatchCatalog.find({}).sort({ order: 1, name: 1 }).lean();
  const out = await Promise.all(
    rows.map(async (r) => {
      const base = serialize(r);
      const filter = { role: "student", ...catalogBatchMongoMatch(r.batch_id) };
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
  const filter = catalogBatchStudentFilter(batch_id, rawSection);

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
  return sendSuccess(res, serialize(doc));
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
  const doc = await BatchCatalog.create({
    batch_id,
    name: body.name,
    order: body.order ?? 0,
    sections,
  });
  return sendSuccess(res, serialize(doc), "Batch created");
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
  await doc.save();
  return sendSuccess(res, serialize(doc), "Batch updated");
}

async function remove(req, res) {
  const batch_id = String(req.params.batch_id || "").trim().toLowerCase();
  if (DEFAULT_BATCHES.some((d) => d.batch_id === batch_id)) {
    return sendError(res, 400, "FORBIDDEN", "Cannot delete a default batch (Spark, Builders, Innovators)");
  }
  const r = await BatchCatalog.deleteOne({ batch_id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Batch not found");
  return sendSuccess(res, {}, "Batch deleted");
}

module.exports = { list, getOne, create, update, remove, listStudentsInBatch };
