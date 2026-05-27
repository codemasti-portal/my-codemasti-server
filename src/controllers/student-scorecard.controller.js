const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const ScorecardEntry = require("../models/ScorecardEntry");
const ScorecardTest = require("../models/ScorecardTest");

const PERIOD_RE = /^\d{4}-\d{2}$/;

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scholarshipLabel(pct) {
  if (pct != null && pct > 0) return `${pct}%`;
  return "";
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
    student_batch_id: String(st.batch_id || "").toLowerCase() || String(st.batch || "").toLowerCase() || "",
    student_batch_label: st.batch || st.batch_id || "",
    test_name: te.name || null,
    exam_type_display: entry.exam_type || te.test_type || "",
    exam_date_resolved: entry.exam_date || te.exam_date || null,
    percentage: pct,
    scholarship_awarded: scholarshipLabel(entry.scholarship_percent),
    test: te.name
      ? {
          id: String(te._id),
          name: te.name,
          test_type: te.test_type,
        }
      : null,
  };
}

function toStudentTestOption(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    test_type: doc.test_type,
    exam_date: doc.exam_date,
    total_marks: doc.total_marks,
  };
}

/**
 * GET /students/scorecard/tests — active tests for filter dropdowns.
 */
async function listActiveScorecardTests(_req, res) {
  const rows = await ScorecardTest.find({ is_active: true })
    .sort({ exam_date: -1, createdAt: -1 })
    .select("name test_type exam_date total_marks")
    .lean();
  return sendSuccess(res, rows.map(toStudentTestOption));
}

/**
 * GET /students/scorecard/records — current student's rows with filters.
 */
async function listMyScorecardRecords(req, res) {
  const sid = req.user?.sub;
  if (!mongoose.Types.ObjectId.isValid(sid)) {
    return sendError(res, 400, "INVALID_USER", "Invalid session");
  }

  const schema = z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
    q: z.string().optional(),
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

  const match = { student_id: new mongoose.Types.ObjectId(sid) };
  if (query.exam_type) {
    match.exam_type = String(query.exam_type).trim().toLowerCase();
  }
  if (query.test_id && mongoose.Types.ObjectId.isValid(query.test_id)) {
    match.test_id = new mongoose.Types.ObjectId(query.test_id);
  }
  if (query.assessment_period) {
    match.assessment_period = query.assessment_period;
  }
  if (query.q?.trim()) {
    match.task_label = new RegExp(escapeRegex(query.q.trim()), "i");
  }

  const sort = { assessment_period: -1, exam_date: -1, updatedAt: -1 };

  const [total, entries] = await Promise.all([
    ScorecardEntry.countDocuments(match),
    ScorecardEntry.find(match).sort(sort).skip(skip).limit(limit).lean(),
  ]);

  const student = await Student.findById(sid)
    .select("name enrollment_number cst_registration_id batch_id batch")
    .lean();

  const testSet = new Set(entries.map((e) => e.test_id).filter(Boolean).map(String));
  const tests =
    testSet.size > 0
      ? await ScorecardTest.find({ _id: { $in: [...testSet] } })
          .select("name test_type exam_date")
          .lean()
      : [];
  const byTest = new Map(tests.map((t) => [String(t._id), t]));

  const data = entries.map((e) =>
    enrichRecord(e, student, e.test_id ? byTest.get(String(e.test_id)) : null)
  );

  return sendSuccess(res, data, "", { page, limit, total });
}

module.exports = {
  listActiveScorecardTests,
  listMyScorecardRecords,
};
