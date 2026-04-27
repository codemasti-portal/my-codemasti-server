const { z } = require("zod");
const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const ScorecardMonth = require("../models/ScorecardMonth");
const ScorecardConfig = require("../models/ScorecardConfig");

const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/, "month_key must be YYYY-MM");

const componentSchema = z.object({
  label: z.string().min(1).trim(),
  obtained: z.coerce.number().min(0),
  total: z.coerce.number().min(0),
  status: z.string().trim().optional().default(""),
});

const subjectSchema = z.object({
  name: z.string().min(1).trim(),
  components: z.array(componentSchema).default([]),
});

const monthlyTestSchema = z
  .object({
    test_name: z.string().trim().optional().default(""),
    test_type: z.string().trim().optional().default(""),
    scholarship_scope: z.string().trim().optional().default("none"),
    obtained: z.coerce.number().min(0).default(0),
    total: z.coerce.number().min(0).default(100),
    note: z.string().trim().optional().default(""),
  })
  .optional()
  .default({ test_name: "", test_type: "", scholarship_scope: "none", obtained: 0, total: 100, note: "" });

const nextMonthFeeSchema = z
  .object({
    actual_fee: z.coerce.number().min(0).default(0),
    scholarship_percent: z.coerce.number().min(0).max(100).default(0),
    scholarship_amount: z.coerce.number().min(0).default(0),
    final_fee: z.coerce.number().min(0).default(0),
    note: z.string().trim().optional().default(""),
  })
  .optional()
  .default({ actual_fee: 0, scholarship_percent: 0, scholarship_amount: 0, final_fee: 0, note: "" });

const scholarshipRuleSchema = z.object({
  min_percent: z.coerce.number().min(0).max(100),
  scholarship_percent: z.coerce.number().min(0).max(100),
});

function normalizeTestNames(names) {
  const cleaned = (names || []).map((n) => String(n || "").trim()).filter(Boolean);
  return [...new Set(cleaned)];
}

function normalizeScholarshipRules(rules) {
  const parsed = (rules || [])
    .map((r) => ({
      min_percent: Number(r.min_percent),
      scholarship_percent: Number(r.scholarship_percent),
    }))
    .filter((r) => Number.isFinite(r.min_percent) && Number.isFinite(r.scholarship_percent))
    .sort((a, b) => b.min_percent - a.min_percent);
  return parsed;
}

function normalizeTestKey(name, type) {
  return `${String(name || "").trim().toLowerCase()}::${String(type || "").trim().toLowerCase()}`;
}

function pickTestEntry(doc, selectedName, selectedType) {
  const tests = Array.isArray(doc?.tests) ? doc.tests : [];
  if (!tests.length) return null;
  if (!selectedName && !selectedType) return tests[0];
  if (selectedName && selectedType) {
    const wanted = normalizeTestKey(selectedName, selectedType);
    const byBoth = tests.find((t) => normalizeTestKey(t.test_name, t.test_type) === wanted);
    if (byBoth) return byBoth;
  }
  if (selectedName) {
    const wantedName = String(selectedName || "").trim().toLowerCase();
    const byName = tests.find((t) => String(t?.test_name || "").trim().toLowerCase() === wantedName);
    if (byName) return byName;
  }
  if (selectedType) {
    const wantedType = String(selectedType || "").trim().toLowerCase();
    const byType = tests.find((t) => String(t?.test_type || "").trim().toLowerCase() === wantedType);
    if (byType) return byType;
  }
  return null;
}

async function getConfig(req, res) {
  const doc = await ScorecardConfig.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return sendSuccess(res, {
    test_names: normalizeTestNames(doc.test_names),
    scholarship_rules: normalizeScholarshipRules(doc.scholarship_rules),
  });
}

async function updateConfig(req, res) {
  const body = z
    .object({
      test_names: z.array(z.string()).min(1),
      scholarship_rules: z.array(scholarshipRuleSchema).min(1),
    })
    .parse(req.body || {});
  const testNames = normalizeTestNames(body.test_names);
  if (!testNames.length) {
    return sendError(res, 400, "VALIDATION_ERROR", "At least one test name is required");
  }
  const scholarshipRules = normalizeScholarshipRules(body.scholarship_rules);
  if (!scholarshipRules.length) {
    return sendError(res, 400, "VALIDATION_ERROR", "At least one scholarship rule is required");
  }
  const doc = await ScorecardConfig.findOneAndUpdate(
    { key: "default" },
    { $set: { key: "default", test_names: testNames, scholarship_rules: scholarshipRules } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return sendSuccess(res, {
    test_names: normalizeTestNames(doc.test_names),
    scholarship_rules: normalizeScholarshipRules(doc.scholarship_rules),
  }, "Config saved");
}

async function listStudentMonths(req, res) {
  const { studentId } = req.params;
  if (!mongoose.isValidObjectId(studentId)) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid student id");
  }
  const rows = await ScorecardMonth.find({ student_id: studentId })
    .select("month_key")
    .sort({ month_key: -1 })
    .lean();
  const data = rows.map((r) => ({
    month_key: r.month_key,
    label: r.month_key.replace(/(\d{4})-(\d{2})/, (_, y, m) => {
      const d = new Date(`${y}-${m}-01T00:00:00.000Z`);
      return d.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
    }),
  }));
  return sendSuccess(res, data);
}

async function getStudentMonth(req, res) {
  const { studentId, monthKey } = req.params;
  const selectedTestName = String(req.query.test_name || "").trim();
  const selectedTestType = String(req.query.test_type || "").trim();
  if (!mongoose.isValidObjectId(studentId)) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid student id");
  }
  const parsedMonthKey = monthKeySchema.parse(monthKey);
  const doc = await ScorecardMonth.findOne({ student_id: studentId, month_key: parsedMonthKey }).lean();
  if (!doc) {
    return sendError(res, 404, "SCORECARD_NOT_FOUND", "No scorecard found for this month");
  }
  const selected = pickTestEntry(doc, selectedTestName, selectedTestType);
  if ((selectedTestName || selectedTestType) && !selected) {
    return sendError(res, 404, "SCORECARD_TEST_NOT_FOUND", "No scorecard found for selected test");
  }
  const monthlyTest =
    selected?.monthly_test ||
    doc.monthly_test || { test_name: "", test_type: "", scholarship_scope: "none", obtained: 0, total: 100, note: "" };
  const nextMonthFee =
    selected?.next_month_fee ||
    doc.next_month_fee || { actual_fee: 0, scholarship_percent: 0, scholarship_amount: 0, final_fee: 0, note: "" };
  const audit = selected?.audit || null;
  return sendSuccess(res, {
    month_key: doc.month_key,
    subjects: doc.subjects || [],
    monthly_test: monthlyTest,
    next_month_fee: nextMonthFee,
    audit,
  });
}

async function upsertStudentMonth(req, res) {
  const { studentId, monthKey } = req.params;
  const selectedTestName = String(req.query.test_name || req.body?.monthly_test?.test_name || "").trim();
  const selectedTestType = String(req.query.test_type || req.body?.monthly_test?.test_type || "").trim();
  if (!mongoose.isValidObjectId(studentId)) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid student id");
  }
  const parsedMonthKey = monthKeySchema.parse(monthKey);
  const body = z
    .object({
      subjects: z.array(subjectSchema).optional().default([]),
      monthly_test: monthlyTestSchema,
      next_month_fee: nextMonthFeeSchema,
    })
    .parse(req.body || {});
  const monthlyTotal = Number(body.monthly_test?.total || 0);
  const monthlyObtained = Number(body.monthly_test?.obtained || 0);
  if (monthlyObtained > monthlyTotal) {
    return sendError(res, 400, "VALIDATION_ERROR", "Marks obtained cannot be greater than total marks");
  }

  const normalizedSubjects = body.subjects.map((subject) => ({
    name: subject.name,
    components: subject.components.map((component) => ({
      label: component.label,
      obtained: Number(component.obtained || 0),
      total: Number(component.total || 0),
      status: component.status || "",
    })),
  }));

  const monthlyTestValue = {
    test_name: selectedTestName || body.monthly_test?.test_name || "",
    test_type: selectedTestType || body.monthly_test?.test_type || "",
    scholarship_scope: body.monthly_test?.scholarship_scope || "none",
    obtained: Number(body.monthly_test?.obtained || 0),
    total: Number(body.monthly_test?.total || 0),
    note: body.monthly_test?.note || "",
  };
  const isFeeLinkedTest = monthlyTestValue.scholarship_scope === "next_month_fee";
  const actualFee = Number(body.next_month_fee?.actual_fee || 0);
  const scholarshipPercent = Number(body.next_month_fee?.scholarship_percent || 0);
  const scholarshipAmount = Math.round((actualFee * scholarshipPercent) / 100);
  const finalFee = Math.max(0, actualFee - scholarshipAmount);
  const requestedFinalFee = Number(body.next_month_fee?.final_fee || 0);
  if (isFeeLinkedTest && requestedFinalFee !== finalFee) {
    return sendError(
      res,
      400,
      "VALIDATION_ERROR",
      "Final fee mismatch. Recalculate fee after scholarship before saving"
    );
  }
  const nextMonthFeeValue = {
    actual_fee: isFeeLinkedTest ? actualFee : 0,
    scholarship_percent: isFeeLinkedTest ? scholarshipPercent : 0,
    scholarship_amount: isFeeLinkedTest ? scholarshipAmount : 0,
    final_fee: isFeeLinkedTest ? finalFee : 0,
    note: body.next_month_fee?.note || "",
  };
  const wantedKey = normalizeTestKey(monthlyTestValue.test_name, monthlyTestValue.test_type);

  let doc = await ScorecardMonth.findOne({ student_id: studentId, month_key: parsedMonthKey });
  if (!doc) {
    doc = new ScorecardMonth({
      student_id: studentId,
      month_key: parsedMonthKey,
      subjects: [],
      tests: [],
    });
  }
  doc.subjects = normalizedSubjects;
  const tests = Array.isArray(doc.tests) ? [...doc.tests] : [];
  const idx = tests.findIndex((t) => normalizeTestKey(t.test_name, t.test_type) === wantedKey);
  const testRow = {
    test_name: monthlyTestValue.test_name,
    test_type: monthlyTestValue.test_type,
    monthly_test: monthlyTestValue,
    next_month_fee: nextMonthFeeValue,
    audit: {
      updated_by: req.staff?.sub && mongoose.isValidObjectId(req.staff.sub) ? req.staff.sub : null,
      updated_by_name: req.staff?.email || "",
      updated_at: new Date(),
    },
  };
  if (idx >= 0) tests[idx] = testRow;
  else tests.push(testRow);
  doc.tests = tests;
  // Keep legacy fields aligned with current selected test for compatibility.
  doc.monthly_test = monthlyTestValue;
  doc.next_month_fee = nextMonthFeeValue;
  await doc.save();
  const lean = doc.toObject();

  return sendSuccess(
    res,
    {
      month_key: lean.month_key,
      subjects: lean.subjects || [],
      monthly_test: monthlyTestValue,
      next_month_fee: nextMonthFeeValue,
      audit: testRow.audit,
    },
    "Scorecard saved"
  );
}

async function deleteStudentMonth(req, res) {
  const { studentId, monthKey } = req.params;
  if (!mongoose.isValidObjectId(studentId)) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid student id");
  }
  const parsedMonthKey = monthKeySchema.parse(monthKey);
  const result = await ScorecardMonth.deleteOne({ student_id: studentId, month_key: parsedMonthKey });
  if (result.deletedCount === 0) {
    return sendError(res, 404, "SCORECARD_NOT_FOUND", "No scorecard found for this month");
  }
  return sendSuccess(res, { student_id: studentId, month_key: parsedMonthKey }, "Deleted");
}

module.exports = {
  getConfig,
  updateConfig,
  listStudentMonths,
  getStudentMonth,
  upsertStudentMonth,
  deleteStudentMonth,
};

