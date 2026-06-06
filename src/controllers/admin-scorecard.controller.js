const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const { catalogBatchMongoMatch, studentsInCatalogBatchesFilter, catalogBatchStudentFilter } = require("../utils/enrollment");
const { studentsInBatchesFilterResolved, catalogBatchMongoMatchResolved } = require("../utils/student-batch-context");
const Student = require("../models/Student");
const ScorecardEntry = require("../models/ScorecardEntry");
const ScorecardTest = require("../models/ScorecardTest");
const { getInstructorAssignedBatchIds, studentInAnyAssignedBatchResolved } = require("../utils/instructorBatchScope");
const registry = require("../utils/batch-catalog-registry");

const PERIOD_RE = /^\d{4}-\d{2}$/;
const TEST_TYPE_ENUM = z.enum(ScorecardTest.SCORECARD_TEST_TYPES);

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBatchId(v) {
  return String(v || "").trim().toLowerCase();
}

function derivePeriod(examDate) {
  if (!examDate) return "";
  const d = new Date(examDate);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function scholarshipLabel(pct, amt) {
  const hasPct = pct != null && pct > 0;
  const hasAmt = amt != null && amt > 0;
  if (!hasPct && !hasAmt) return "";
  if (hasAmt && hasPct) return `₹${amt} (${pct}%)`;
  if (hasAmt) return `₹${amt}`;
  return `${pct}%`;
}

function pctValue(obtained, total) {
  const t = Number(total);
  const o = Number(obtained);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(o)) return null;
  return Math.round((o / t) * 1000) / 10;
}

function toRow(doc) {
  return {
    id: String(doc._id),
    batch_id: doc.batch_id,
    student_id: String(doc.student_id),
    test_id: doc.test_id ? String(doc.test_id) : null,
    exam_type: doc.exam_type || "",
    exam_date: doc.exam_date || null,
    assessment_period: doc.assessment_period,
    task_label: doc.task_label,
    total_marks: doc.total_marks,
    marks_obtained: doc.marks_obtained,
    scholarship_percent: doc.scholarship_percent ?? null,
    scholarship_amount: doc.scholarship_amount ?? null,
    performance_status: doc.performance_status || "",
    batch_recommendation: doc.batch_recommendation || "",
    next_month_fee: doc.next_month_fee ?? null,
    notes: doc.notes || "",
    updated_at: doc.updatedAt,
    created_at: doc.createdAt,
  };
}

function toTestRow(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    test_type: doc.test_type,
    exam_date: doc.exam_date,
    total_marks: doc.total_marks,
    scholarship_rules: doc.scholarship_rules || "",
    batch_allocation_rules: doc.batch_allocation_rules || "",
    description: doc.description || "",
    is_active: Boolean(doc.is_active),
    updated_at: doc.updatedAt,
    created_at: doc.createdAt,
  };
}

function enrichRecord(entry, student, test) {
  const st = student || {};
  const te = test || {};
  const pct = pctValue(entry.marks_obtained, entry.total_marks);
  return {
    ...toRow(entry),
    student_name: st.name || "",
    cst_id: st.cst_registration_id || "",
    enrollment_number: st.enrollment_number || "",
    // The batch this SCORE belongs to is the entry's own batch context (the test was scored under this
    // batch), not the student's primary batch — which differs for a multi-batch student.
    student_batch_id: String(entry.batch_id || st.batch_id || "").toLowerCase() || String(st.batch || "").toLowerCase() || "",
    student_batch_label:
      registry.displayNameSync(String(entry.batch_id || "").toLowerCase()) || entry.batch_id || st.batch || st.batch_id || "",
    test_name: te.name || null,
    exam_type_display: entry.exam_type || te.test_type || "",
    exam_date_resolved: entry.exam_date || te.exam_date || null,
    percentage: pct,
    scholarship_awarded: scholarshipLabel(entry.scholarship_percent, entry.scholarship_amount),
    test: te.name
      ? {
          id: String(te._id),
          name: te.name,
          test_type: te.test_type,
          scholarship_rules: te.scholarship_rules || "",
          batch_allocation_rules: te.batch_allocation_rules || "",
          description: te.description || "",
        }
      : null,
  };
}

const upsertBodySchema = z.object({
  batch_id: z.string().min(1).max(40).trim(),
  student_id: z.string().min(1),
  assessment_period: z.string().regex(PERIOD_RE, "Use YYYY-MM"),
  task_label: z.string().max(200).trim().optional().default(""),
  test_id: z.string().optional(),
  total_marks: z.coerce.number().min(0).optional(),
  marks_obtained: z.coerce.number().min(0),
  scholarship_percent: z.union([z.coerce.number().min(0).max(100), z.null()]).optional(),
  scholarship_amount: z.union([z.coerce.number().min(0), z.null()]).optional(),
  performance_status: z.string().max(120).optional(),
  batch_recommendation: z.string().max(80).trim().optional(),
  next_month_fee: z.union([z.coerce.number().min(0), z.null()]).optional(),
  notes: z.string().max(2000).optional().default(""),
});

const patchBodySchema = z
  .object({
    task_label: z.string().min(1).max(200).trim().optional(),
    total_marks: z.coerce.number().min(0).optional(),
    marks_obtained: z.coerce.number().min(0).optional(),
    scholarship_percent: z.union([z.coerce.number().min(0).max(100), z.null()]).optional(),
    scholarship_amount: z.union([z.coerce.number().min(0), z.null()]).optional(),
    notes: z.string().max(2000).optional(),
    performance_status: z.string().max(120).optional(),
    batch_recommendation: z.string().max(80).trim().optional(),
    next_month_fee: z.union([z.coerce.number().min(0), z.null()]).optional(),
    exam_date: z.union([z.coerce.date(), z.null()]).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No updates" });

const createTestSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  test_type: TEST_TYPE_ENUM,
  exam_date: z.coerce.date(),
  total_marks: z.coerce.number().min(0),
  scholarship_rules: z.string().max(8000).optional().default(""),
  batch_allocation_rules: z.string().max(8000).optional().default(""),
  description: z.string().max(4000).optional().default(""),
  is_active: z.coerce.boolean().optional().default(true),
});

const patchTestSchema = z
  .object({
    name: z.string().min(1).max(200).trim().optional(),
    test_type: TEST_TYPE_ENUM.optional(),
    exam_date: z.coerce.date().optional(),
    total_marks: z.coerce.number().min(0).optional(),
    scholarship_rules: z.string().max(8000).optional(),
    batch_allocation_rules: z.string().max(8000).optional(),
    description: z.string().max(4000).optional(),
    is_active: z.coerce.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No updates" });

async function assertStudentInBatch(batchId, studentId) {
  if (!mongoose.Types.ObjectId.isValid(studentId)) {
    return null;
  }
  // Read-switch: legacy spreads the batch_id/enrollment partial; non-legacy resolves the batch's
  // enrolled student-id set and checks membership (avoids a double-_id key collision in the filter).
  const scope = await catalogBatchMongoMatchResolved(batchId);
  if (scope && scope._id && Array.isArray(scope._id.$in)) {
    const inSet = scope._id.$in.some((x) => String(x) === String(studentId));
    if (!inSet) return null;
    const student = await Student.findOne({ _id: studentId, role: "student" }).select("_id").lean();
    return student || null;
  }
  const student = await Student.findOne({
    _id: studentId,
    role: "student",
    ...scope,
  })
    .select("_id")
    .lean();
  return student || null;
}

async function loadTestForWrite(testId) {
  if (!mongoose.Types.ObjectId.isValid(testId)) return null;
  return ScorecardTest.findById(testId).lean();
}

function matchScholarshipSlab(rulesStr, percentage) {
  if (!rulesStr || percentage == null) return null;
  try {
    const slabs = JSON.parse(rulesStr);
    if (!Array.isArray(slabs)) return null;
    for (const slab of slabs) {
      if (percentage >= slab.min_pct && percentage <= slab.max_pct) return slab;
    }
  } catch {}
  return null;
}

/** Apply test defaults to create payload when test_id is present. */
function applyTestDefaults(body, test) {
  const next = { ...body };
  next.task_label = test.name;
  next.exam_type = test.test_type;
  next.exam_date = test.exam_date;
  if (next.total_marks == null || next.total_marks === undefined || next.total_marks === "") {
    next.total_marks = test.total_marks;
  }
  return next;
}

async function listEntries(req, res) {
  const schema = z.object({
    student_id: z.string().min(1),
    assessment_period: z.string().regex(PERIOD_RE),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid query";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const query = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(query.student_id)) {
    return sendError(res, 400, "INVALID_STUDENT", "Invalid student id");
  }
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, []);
    }
    const st = await Student.findOne({ _id: query.student_id, role: "student" }).lean();
    if (!st || !(await studentInAnyAssignedBatchResolved(st, instructorBatches))) {
      return sendError(res, 403, "FORBIDDEN", "Student is not in your assigned batches");
    }
  }
  const rows = await ScorecardEntry.find({
    student_id: query.student_id,
    assessment_period: query.assessment_period,
  })
    .sort({ task_label: 1 })
    .lean();
  return sendSuccess(res, rows.map(toRow));
}

async function createEntry(req, res) {
  let parsed = upsertBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  let body = parsed.data;

  let testDoc = null;
  if (body.test_id) {
    if (!mongoose.Types.ObjectId.isValid(body.test_id)) {
      return sendError(res, 400, "INVALID_TEST", "Invalid test id");
    }
    testDoc = await loadTestForWrite(body.test_id);
    if (!testDoc) return sendError(res, 404, "TEST_NOT_FOUND", "Test not found");
    body = applyTestDefaults(body, testDoc);
  } else if (!String(body.task_label || "").trim()) {
    return sendError(res, 400, "VALIDATION_ERROR", "Choose or enter a task name.");
  } else {
    body.task_label = String(body.task_label).trim();
  }

  const tm = Number(body.total_marks);
  if (!Number.isFinite(tm) || tm < 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Enter a valid total marks value.");
  }

  const mo = Number(body.marks_obtained);
  if (tm > 0 && mo > tm) {
    return sendError(res, 400, "VALIDATION_ERROR", "Marks obtained cannot exceed total marks.");
  }

  const batchId = normalizeBatchId(body.batch_id);
  const ok = await assertStudentInBatch(batchId, body.student_id);
  if (!ok) {
    return sendError(res, 404, "STUDENT_NOT_IN_BATCH", "Student not found in this batch");
  }

  let schPct = body.scholarship_percent ?? null;
  let schAmt = body.scholarship_amount ?? null;
  if (testDoc && schPct == null && schAmt == null) {
    const pct = pctValue(body.marks_obtained, tm);
    const slab = matchScholarshipSlab(testDoc.scholarship_rules, pct);
    if (slab) {
      schPct = slab.scholarship_percent ?? null;
      schAmt = slab.scholarship_amount ?? null;
    }
  }

  const createPayload = {
    batch_id: batchId,
    student_id: body.student_id,
    test_id: testDoc ? testDoc._id : null,
    exam_type: body.exam_type || (testDoc ? testDoc.test_type : ""),
    exam_date: body.exam_date || (testDoc ? testDoc.exam_date : null),
    assessment_period: body.assessment_period,
    task_label: body.task_label,
    total_marks: tm,
    marks_obtained: body.marks_obtained,
    scholarship_percent: schPct,
    scholarship_amount: schAmt,
    performance_status: body.performance_status ?? "",
    batch_recommendation: body.batch_recommendation ?? "",
    next_month_fee: body.next_month_fee ?? null,
    notes: body.notes ?? "",
    updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
  };

  try {
    const created = await ScorecardEntry.create(createPayload);
    return sendSuccess(res, toRow(created.toObject()), "Score saved");
  } catch (e) {
    if (e?.code === 11000) {
      return sendError(
        res,
        409,
        "DUPLICATE_TASK",
        "An entry for this student, period, and task already exists — edit it instead."
      );
    }
    throw e;
  }
}

async function patchEntry(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid entry id");
  }
  const parsed = patchBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const body = parsed.data;

  const doc = await ScorecardEntry.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Entry not found");

  const stillOk = await assertStudentInBatch(doc.batch_id, String(doc.student_id));
  if (!stillOk) {
    return sendError(res, 404, "STUDENT_NOT_IN_BATCH", "Student not found in this batch");
  }

  const nextTask = body.task_label !== undefined ? body.task_label : doc.task_label;
  const dup = await ScorecardEntry.findOne({
    student_id: doc.student_id,
    assessment_period: doc.assessment_period,
    task_label: nextTask,
    _id: { $ne: doc._id },
  }).select("_id");
  if (dup) {
    return sendError(res, 409, "DUPLICATE_TASK", "Another row already uses this task label for this period.");
  }

  if (body.task_label !== undefined) doc.task_label = body.task_label;
  if (body.total_marks !== undefined) doc.total_marks = body.total_marks;
  if (body.marks_obtained !== undefined) doc.marks_obtained = body.marks_obtained;
  if (body.scholarship_percent !== undefined) doc.scholarship_percent = body.scholarship_percent;
  if (body.scholarship_amount !== undefined) doc.scholarship_amount = body.scholarship_amount;
  if (body.notes !== undefined) doc.notes = body.notes;
  if (body.performance_status !== undefined) doc.performance_status = body.performance_status;
  if (body.batch_recommendation !== undefined) doc.batch_recommendation = body.batch_recommendation;
  if (body.next_month_fee !== undefined) doc.next_month_fee = body.next_month_fee;
  if (body.exam_date !== undefined) doc.exam_date = body.exam_date;

  const finalTotal = Number(doc.total_marks);
  const finalObtained = Number(doc.marks_obtained);
  if (finalTotal > 0 && finalObtained > finalTotal) {
    return sendError(res, 400, "VALIDATION_ERROR", "Marks obtained cannot exceed total marks.");
  }

  if (req.staff?.sub) doc.updated_by_staff_id = new mongoose.Types.ObjectId(req.staff.sub);

  await doc.save();
  return sendSuccess(res, toRow(doc.toObject()), "Score updated");
}

async function deleteEntry(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid entry id");
  }
  const r = await ScorecardEntry.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Entry not found");
  return sendSuccess(res, { id: req.params.id }, "Entry deleted");
}

async function listTests(req, res) {
  const schema = z.object({
    active_only: z.enum(["0", "1", "true", "false"]).optional(),
  });
  const q = schema.safeParse(req.query);
  const activeOnly = q.success && /^(1|true)$/i.test(String(q.data.active_only || ""));
  const filter = activeOnly ? { is_active: true } : {};
  const rows = await ScorecardTest.find(filter).sort({ exam_date: -1, createdAt: -1 }).lean();
  return sendSuccess(res, rows.map(toTestRow));
}

async function createTest(req, res) {
  const parsed = createTestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const body = parsed.data;
  const created = await ScorecardTest.create({
    name: body.name,
    test_type: body.test_type,
    exam_date: body.exam_date,
    total_marks: body.total_marks,
    scholarship_rules: body.scholarship_rules ?? "",
    batch_allocation_rules: body.batch_allocation_rules ?? "",
    description: body.description ?? "",
    is_active: body.is_active !== false,
    updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
  });
  return sendSuccess(res, toTestRow(created.toObject()), "Test created");
}

async function patchTest(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid test id");
  }
  const parsed = patchTestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const body = parsed.data;
  const doc = await ScorecardTest.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Test not found");

  if (body.name !== undefined) doc.name = body.name;
  if (body.test_type !== undefined) doc.test_type = body.test_type;
  if (body.exam_date !== undefined) doc.exam_date = body.exam_date;
  if (body.total_marks !== undefined) doc.total_marks = body.total_marks;
  if (body.scholarship_rules !== undefined) doc.scholarship_rules = body.scholarship_rules;
  if (body.batch_allocation_rules !== undefined) doc.batch_allocation_rules = body.batch_allocation_rules;
  if (body.description !== undefined) doc.description = body.description;
  if (body.is_active !== undefined) doc.is_active = body.is_active;

  if (req.staff?.sub) doc.updated_by_staff_id = new mongoose.Types.ObjectId(req.staff.sub);
  await doc.save();

  await ScorecardEntry.updateMany(
    { test_id: doc._id },
    {
      $set: {
        exam_type: doc.test_type,
        exam_date: doc.exam_date,
        task_label: doc.name,
        total_marks: doc.total_marks,
      },
    }
  );

  return sendSuccess(res, toTestRow(doc.toObject()), "Test updated");
}

async function deleteTest(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid test id");
  }
  const linked = await ScorecardEntry.countDocuments({ test_id: req.params.id });
  if (linked > 0) {
    return sendError(res, 409, "TEST_IN_USE", "Archive or reassign score rows before deleting this test.");
  }
  const r = await ScorecardTest.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Test not found");
  return sendSuccess(res, { id: req.params.id }, "Test removed");
}

async function listRecords(req, res) {
  const schema = z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    q: z.string().optional(),
    batch_id: z.string().optional(),
    exam_type: z.string().optional(),
    test_id: z.string().optional(),
    assessment_period: z.string().regex(PERIOD_RE).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid query";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const query = parsed.data;
  const page = query.page || 1;
  const limit = query.limit || 25;
  const skip = (page - 1) * limit;

  const match = {};
  if (query.batch_id) {
    match.batch_id = normalizeBatchId(query.batch_id);
  }
  if (query.exam_type) {
    match.exam_type = String(query.exam_type).trim().toLowerCase();
  }
  if (query.test_id && mongoose.Types.ObjectId.isValid(query.test_id)) {
    match.test_id = new mongoose.Types.ObjectId(query.test_id);
  }
  if (query.assessment_period) {
    match.assessment_period = query.assessment_period;
  }

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    if (match.batch_id) {
      const b = String(match.batch_id).trim().toLowerCase();
      if (!instructorBatches.includes(b)) {
        return sendSuccess(res, [], "", { page, limit, total: 0 });
      }
    } else {
      match.batch_id = { $in: instructorBatches };
    }
  }

  let studentIds = null;
  if (query.q?.trim()) {
    const rx = new RegExp(escapeRegex(query.q.trim()), "i");
    const nameFilter = {
      role: "student",
      $or: [{ name: rx }, { email: rx }, { enrollment_number: rx }, { cst_registration_id: rx }],
    };
    const studQuery =
      instructorBatches !== null && instructorBatches.length
        ? { $and: [nameFilter, { $or: studentsInCatalogBatchesFilter(instructorBatches).$or }] }
        : instructorBatches !== null && !instructorBatches.length
          ? { _id: null }
          : nameFilter;
    const studs = await Student.find(studQuery).select("_id").lean();
    studentIds = studs.map((s) => s._id);
    if (!studentIds.length) {
      return sendSuccess(res, [], "", { page, limit, total: 0 });
    }
    match.student_id = { $in: studentIds };
  }

  const [total, entries] = await Promise.all([
    ScorecardEntry.countDocuments(match),
    ScorecardEntry.find(match).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);

  const studSet = new Set(entries.map((e) => String(e.student_id)));
  const testSet = new Set(entries.map((e) => e.test_id).filter(Boolean).map(String));

  const [students, tests] = await Promise.all([
    Student.find({ _id: { $in: [...studSet] } })
      .select("name enrollment_number cst_registration_id batch_id batch")
      .lean(),
    testSet.size
      ? ScorecardTest.find({ _id: { $in: [...testSet] } })
          .select("name test_type exam_date scholarship_rules batch_allocation_rules description")
          .lean()
      : [],
  ]);

  const byStudent = new Map(students.map((s) => [String(s._id), s]));
  const byTest = new Map(tests.map((t) => [String(t._id), t]));

  const data = entries.map((e) =>
    enrichRecord(e, byStudent.get(String(e.student_id)), e.test_id ? byTest.get(String(e.test_id)) : null)
  );

  return sendSuccess(res, data, "", { page, limit, total });
}

async function scorecardSummary(req, res) {
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  let instMatch = null;
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      const activeOnly = await ScorecardTest.countDocuments({ is_active: true });
      return sendSuccess(res, {
        active_tests: activeOnly,
        total_score_rows: 0,
        avg_percentage: null,
        rows_with_scholarship: 0,
        by_batch: [],
        by_exam_type: [],
      });
    }
    instMatch = { batch_id: { $in: instructorBatches } };
  }

  const pre = instMatch ? [{ $match: instMatch }] : [];
  const countFilter = instMatch || {};

  const [activeTests, totalRows, batchAgg, typeAgg, avgRow] = await Promise.all([
    ScorecardTest.countDocuments({ is_active: true }),
    ScorecardEntry.countDocuments(countFilter),
    ScorecardEntry.aggregate([
      ...pre,
      {
        $group: {
          _id: "$batch_id",
          c: { $sum: 1 },
          avgPct: {
            $avg: {
              $cond: [
                { $gt: ["$total_marks", 0] },
                { $multiply: [{ $divide: ["$marks_obtained", "$total_marks"] }, 100] },
                null,
              ],
            },
          },
        },
      },
    ]),
    ScorecardEntry.aggregate([
      ...pre,
      { $match: { exam_type: { $nin: ["", null] } } },
      { $group: { _id: "$exam_type", c: { $sum: 1 } } },
    ]),
    ScorecardEntry.aggregate([
      ...pre,
      {
        $group: {
          _id: null,
          avgPct: {
            $avg: {
              $cond: [
                { $gt: ["$total_marks", 0] },
                { $multiply: [{ $divide: ["$marks_obtained", "$total_marks"] }, 100] },
                null,
              ],
            },
          },
          withSch: {
            $sum: {
              $cond: [{ $or: [{ $gt: ["$scholarship_percent", 0] }, { $gt: ["$scholarship_amount", 0] }] }, 1, 0],
            },
          },
        },
      },
    ]),
  ]);

  const avgPctAll = avgRow[0]?.avgPct != null ? Math.round(Number(avgRow[0].avgPct) * 10) / 10 : null;
  const withScholarship = avgRow[0]?.withSch || 0;

  return sendSuccess(res, {
    active_tests: activeTests,
    total_score_rows: totalRows,
    avg_percentage: avgPctAll,
    rows_with_scholarship: withScholarship,
    by_batch: batchAgg.map((b) => ({
      batch_id: b._id || "",
      avg_percentage: b.avgPct != null ? Math.round(Number(b.avgPct) * 10) / 10 : null,
      count: b.c,
    })),
    by_exam_type: typeAgg.map((t) => ({ exam_type: t._id, count: t.c })),
  });
}

const bulkRowSchema = z.object({
  batch_id: z.string().min(1).max(40).trim(),
  student_id: z.string().min(1),
  assessment_period: z.string().regex(PERIOD_RE),
  test_id: z.string().optional(),
  task_label: z.string().max(200).trim().optional(),
  total_marks: z.coerce.number().min(0).optional(),
  marks_obtained: z.coerce.number().min(0),
  scholarship_percent: z.union([z.coerce.number().min(0).max(100), z.null()]).optional(),
  scholarship_amount: z.union([z.coerce.number().min(0), z.null()]).optional(),
  performance_status: z.string().max(120).optional(),
  batch_recommendation: z.string().max(80).trim().optional(),
  next_month_fee: z.union([z.coerce.number().min(0), z.null()]).optional(),
  notes: z.string().max(2000).optional().default(""),
});

const bulkBodySchema = z.object({
  rows: z.array(bulkRowSchema).min(1).max(500),
});

async function bulkCreateEntries(req, res) {
  const parsed = bulkBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const { rows } = parsed.data;
  let created = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      let body = { ...row };
      let testDoc = null;
      if (body.test_id) {
        if (!mongoose.Types.ObjectId.isValid(body.test_id)) {
          errors.push({ index: i, message: "Invalid test_id" });
          continue;
        }
        testDoc = await loadTestForWrite(body.test_id);
        if (!testDoc) {
          errors.push({ index: i, message: "Test not found" });
          continue;
        }
        body = applyTestDefaults(
          {
            ...body,
            task_label: testDoc.name,
            total_marks: body.total_marks ?? testDoc.total_marks,
          },
          testDoc
        );
      } else if (!body.task_label?.trim()) {
        errors.push({ index: i, message: "task_label or test_id required" });
        continue;
      }

      const batchId = normalizeBatchId(body.batch_id);
      const ok = await assertStudentInBatch(batchId, body.student_id);
      if (!ok) {
        errors.push({ index: i, message: "Student not in batch" });
        continue;
      }

      const tm = Number(body.total_marks);
      if (!Number.isFinite(tm) || tm < 0) {
        errors.push({ index: i, message: "Invalid total_marks" });
        continue;
      }

      const bulkMo = Number(body.marks_obtained);
      if (tm > 0 && bulkMo > tm) {
        errors.push({ index: i, message: "Marks obtained cannot exceed total marks" });
        continue;
      }

      let bulkSchPct = body.scholarship_percent ?? null;
      let bulkSchAmt = body.scholarship_amount ?? null;
      if (testDoc && bulkSchPct == null && bulkSchAmt == null) {
        const bulkPct = pctValue(body.marks_obtained, tm);
        const slab = matchScholarshipSlab(testDoc.scholarship_rules, bulkPct);
        if (slab) {
          bulkSchPct = slab.scholarship_percent ?? null;
          bulkSchAmt = slab.scholarship_amount ?? null;
        }
      }

      await ScorecardEntry.create({
        batch_id: batchId,
        student_id: body.student_id,
        test_id: testDoc ? testDoc._id : null,
        exam_type: body.exam_type || (testDoc ? testDoc.test_type : ""),
        exam_date: body.exam_date || (testDoc ? testDoc.exam_date : null),
        assessment_period: body.assessment_period,
        task_label: body.task_label.trim(),
        total_marks: tm,
        marks_obtained: body.marks_obtained,
        scholarship_percent: bulkSchPct,
        scholarship_amount: bulkSchAmt,
        performance_status: body.performance_status ?? "",
        batch_recommendation: body.batch_recommendation ?? "",
        next_month_fee: body.next_month_fee ?? null,
        notes: body.notes ?? "",
        updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
      });
      created += 1;
    } catch (e) {
      if (e?.code === 11000) {
        errors.push({ index: i, message: "Duplicate task for student/period" });
      } else {
        errors.push({ index: i, message: e.message || "Save failed" });
      }
    }
  }

  return sendSuccess(res, { created, errors }, created ? "Bulk import finished" : "No rows imported", {
    created,
    error_count: errors.length,
  });
}

async function spreadsheetStudents(req, res) {
  const schema = z.object({
    batch_id: z.string().min(1),
    test_id: z.string().min(1),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid query";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const { batch_id, test_id } = parsed.data;

  if (!mongoose.Types.ObjectId.isValid(test_id)) {
    return sendError(res, 400, "INVALID_TEST", "Invalid test id");
  }
  const test = await ScorecardTest.findById(test_id).lean();
  if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Test not found");

  const assessment_period = derivePeriod(test.exam_date);

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, { test: toTestRow(test), assessment_period, students: [] });
    }
    const b = normalizeBatchId(batch_id);
    if (!instructorBatches.includes(b)) {
      return sendError(res, 403, "FORBIDDEN", "Batch is not in your assigned batches");
    }
  }

  const filter = await studentsInBatchesFilterResolved([batch_id]);
  const students = await Student.find(filter)
    .select("_id name email enrollment_number cst_registration_id batch_id batch")
    .sort({ enrollment_number: 1, name: 1 })
    .lean();

  const studentIds = students.map((s) => s._id);

  const existingEntries = studentIds.length
    ? await ScorecardEntry.find({
        test_id: new mongoose.Types.ObjectId(test_id),
        assessment_period,
        student_id: { $in: studentIds },
      }).lean()
    : [];

  const entryByStudent = new Map(existingEntries.map((e) => [String(e.student_id), e]));

  const data = students.map((s) => {
    const entry = entryByStudent.get(String(s._id)) || null;
    return {
      student_id: String(s._id),
      name: s.name || "",
      cst_id: s.cst_registration_id || "",
      enrollment_number: s.enrollment_number || "",
      existing_entry: entry
        ? {
            id: String(entry._id),
            marks_obtained: entry.marks_obtained,
            scholarship_percent: entry.scholarship_percent ?? null,
            scholarship_amount: entry.scholarship_amount ?? null,
          }
        : null,
    };
  });

  return sendSuccess(res, {
    test: {
      id: String(test._id),
      name: test.name,
      test_type: test.test_type,
      exam_date: test.exam_date,
      total_marks: test.total_marks,
      scholarship_rules: test.scholarship_rules || "",
    },
    assessment_period,
    students: data,
  });
}

async function batchSaveEntries(req, res) {
  const bodySchema = z.object({
    test_id: z.string().min(1),
    batch_id: z.string().min(1).max(40),
    rows: z
      .array(
        z.object({
          student_id: z.string().min(1),
          marks_obtained: z.coerce.number().min(0),
        })
      )
      .min(1)
      .max(500),
  });
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const { test_id, batch_id, rows } = parsed.data;

  if (!mongoose.Types.ObjectId.isValid(test_id)) {
    return sendError(res, 400, "INVALID_TEST", "Invalid test id");
  }
  const test = await loadTestForWrite(test_id);
  if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Test not found");

  const task_label = test.name;
  const exam_type = test.test_type;
  const exam_date = test.exam_date;
  const total_marks = test.total_marks;
  const assessment_period = derivePeriod(exam_date);
  const batchNorm = normalizeBatchId(batch_id);

  let created = 0;
  let updated = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (row.marks_obtained > total_marks) {
        errors.push({ index: i, student_id: row.student_id, message: "Marks obtained cannot exceed total marks" });
        continue;
      }
      const percentage = pctValue(row.marks_obtained, total_marks);
      const slab = matchScholarshipSlab(test.scholarship_rules, percentage);
      const scholarship_percent = slab?.scholarship_percent ?? null;
      const scholarship_amount = slab?.scholarship_amount ?? null;

      const result = await ScorecardEntry.findOneAndUpdate(
        { student_id: row.student_id, assessment_period, task_label },
        {
          $set: {
            batch_id: batchNorm,
            test_id: test._id,
            exam_type,
            exam_date,
            total_marks,
            marks_obtained: row.marks_obtained,
            scholarship_percent,
            scholarship_amount,
            updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
          },
        },
        { upsert: true, new: true, rawResult: true }
      );
      if (result.lastErrorObject?.updatedExisting) {
        updated += 1;
      } else {
        created += 1;
      }
    } catch (e) {
      errors.push({ index: i, student_id: row.student_id, message: e.message || "Save failed" });
    }
  }

  return sendSuccess(res, { created, updated, errors }, created || updated ? "Batch save finished" : "No rows saved");
}

async function bulkCreateByCst(req, res) {
  const bodySchema = z.object({
    test_id: z.string().min(1),
    batch_id: z.string().min(1).max(40),
    rows: z
      .array(
        z.object({
          cst_id: z.string().min(1),
          marks_obtained: z.coerce.number().min(0),
        })
      )
      .min(1)
      .max(500),
  });
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const { test_id, rows } = parsed.data;

  if (!mongoose.Types.ObjectId.isValid(test_id)) {
    return sendError(res, 400, "INVALID_TEST", "Invalid test id");
  }
  const test = await loadTestForWrite(test_id);
  if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Test not found");

  // Import is scoped to ONE batch: each score is attributed to THIS batch (correct for multi-batch
  // students), and CSV rows for students not active in this batch are reported rather than mis-filed.
  const batchNorm = normalizeBatchId(parsed.data.batch_id);

  const task_label = test.name;
  const exam_type = test.test_type;
  const exam_date = test.exam_date;
  const total_marks = test.total_marks;
  const assessment_period = derivePeriod(exam_date);

  const cstIds = [...new Set(rows.map((r) => r.cst_id))];
  const batchFilter = await studentsInBatchesFilterResolved([batchNorm]);
  const students = await Student.find({ ...batchFilter, cst_registration_id: { $in: cstIds } })
    .select("_id cst_registration_id")
    .lean();
  const byCst = new Map(students.map((s) => [s.cst_registration_id, s]));

  let created = 0;
  let updated = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const student = byCst.get(row.cst_id);
    if (!student) {
      errors.push({ index: i, cst_id: row.cst_id, message: "No student in this batch with this CST ID" });
      continue;
    }
    try {
      if (row.marks_obtained > total_marks) {
        errors.push({ index: i, cst_id: row.cst_id, message: "Marks obtained cannot exceed total marks" });
        continue;
      }
      const percentage = pctValue(row.marks_obtained, total_marks);
      const slab = matchScholarshipSlab(test.scholarship_rules, percentage);
      const scholarship_percent = slab?.scholarship_percent ?? null;
      const scholarship_amount = slab?.scholarship_amount ?? null;


      const result = await ScorecardEntry.findOneAndUpdate(
        { student_id: student._id, assessment_period, task_label },
        {
          $set: {
            batch_id: batchNorm,
            test_id: test._id,
            exam_type,
            exam_date,
            total_marks,
            marks_obtained: row.marks_obtained,
            scholarship_percent,
            scholarship_amount,
            updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
          },
        },
        { upsert: true, new: true, rawResult: true }
      );
      if (result.lastErrorObject?.updatedExisting) {
        updated += 1;
      } else {
        created += 1;
      }
    } catch (e) {
      errors.push({ index: i, cst_id: row.cst_id, message: e.message || "Save failed" });
    }
  }

  return sendSuccess(res, { created, updated, errors }, created || updated ? "Bulk CST import finished" : "No rows saved");
}

/**
 * POST /admin/scorecard/tests/:id/mark-absent-zero  body: { batch_id }
 * For every student in `batch_id` who does NOT already have a ScorecardEntry for this test,
 * create one with marks_obtained = 0, scholarship_percent = 0, scholarship_amount = 0.
 * Absent students do not earn scholarship from slabs even if a slab would match 0%.
 */
async function markAbsentAsZero(req, res) {
  const bodySchema = z.object({ batch_id: z.string().min(1).max(40) });
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  }
  const { batch_id } = parsed.data;
  const testId = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(testId)) {
    return sendError(res, 400, "INVALID_TEST", "Invalid test id");
  }

  const test = await ScorecardTest.findById(testId).lean();
  if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Test not found");

  const batchNorm = normalizeBatchId(batch_id);
  const assessment_period = derivePeriod(test.exam_date);
  const task_label = test.name;

  // Instructor-batch scope check (mirrors spreadsheetStudents).
  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length || !instructorBatches.includes(batchNorm)) {
      return sendError(res, 403, "FORBIDDEN", "Batch is not in your assigned batches");
    }
  }

  const students = await Student.find(await studentsInBatchesFilterResolved([batch_id]))
    .select("_id")
    .lean();
  const studentIds = students.map((s) => s._id);
  if (!studentIds.length) {
    return sendSuccess(res, { created: 0, already_present: 0, total_students: 0 }, "No students in batch");
  }

  const existing = await ScorecardEntry.find({
    test_id: new mongoose.Types.ObjectId(testId),
    student_id: { $in: studentIds },
  })
    .select("student_id")
    .lean();
  const have = new Set(existing.map((e) => String(e.student_id)));

  const toCreate = studentIds.filter((sid) => !have.has(String(sid)));
  if (!toCreate.length) {
    return sendSuccess(
      res,
      { created: 0, already_present: existing.length, total_students: studentIds.length },
      "All students already have an entry"
    );
  }

  const docs = toCreate.map((sid) => ({
    batch_id: batchNorm,
    student_id: sid,
    test_id: test._id,
    exam_type: test.test_type,
    exam_date: test.exam_date,
    assessment_period,
    task_label,
    total_marks: test.total_marks,
    marks_obtained: 0,
    scholarship_percent: 0,
    scholarship_amount: 0,
    updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
  }));

  let created = 0;
  try {
    const r = await ScorecardEntry.insertMany(docs, { ordered: false });
    created = r.length;
  } catch (err) {
    // Some inserts may fail due to a race with concurrent saves; report partial success.
    if (Array.isArray(err.insertedDocs)) created = err.insertedDocs.length;
  }

  return sendSuccess(
    res,
    { created, already_present: existing.length, total_students: studentIds.length },
    `Marked ${created} student${created === 1 ? "" : "s"} absent (0 marks)`
  );
}

module.exports = {
  listEntries,
  createEntry,
  patchEntry,
  deleteEntry,
  listTests,
  createTest,
  patchTest,
  deleteTest,
  listRecords,
  scorecardSummary,
  bulkCreateEntries,
  spreadsheetStudents,
  batchSaveEntries,
  bulkCreateByCst,
  markAbsentAsZero,
};
