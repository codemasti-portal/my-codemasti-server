const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const ScorecardMonth = require("../models/ScorecardMonth");

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

async function months(req, res) {
  const rows = await ScorecardMonth.find({ student_id: req.user.sub })
    .select("month_key")
    .sort({ month_key: -1 })
    .lean();
  const keys = rows.map((r) => r.month_key);
  const data = keys.map((key) => ({
    month_key: key,
    label: key.replace(/(\d{4})-(\d{2})/, (_, y, m) => {
      const d = new Date(`${y}-${m}-01T00:00:00.000Z`);
      return d.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
    }),
  }));
  return sendSuccess(res, data);
}

async function detail(req, res) {
  const month_key = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.month_key);
  const selectedTestName = String(req.query.test_name || "").trim();
  const selectedTestType = String(req.query.test_type || "").trim();
  const doc = await ScorecardMonth.findOne({ student_id: req.user.sub, month_key }).lean();
  if (!doc) {
    return sendError(res, 404, "SCORECARD_NOT_FOUND", "No scorecard for this month");
  }
  const selected = pickTestEntry(doc, selectedTestName, selectedTestType);
  if ((selectedTestName || selectedTestType) && !selected) {
    return sendError(res, 404, "SCORECARD_TEST_NOT_FOUND", "No scorecard for selected test");
  }
  const availableTestEntries = (Array.isArray(doc.tests) ? doc.tests : [])
    .map((t) => ({
      test_name: String(t?.test_name || "").trim(),
      test_type: String(t?.test_type || "").trim(),
      scholarship_scope: String(t?.monthly_test?.scholarship_scope || "none"),
    }))
    .filter((t) => t.test_name);
  const availableTests = availableTestEntries.map((t) => t.test_name);
  if (!availableTests.length && doc.monthly_test?.test_name) {
    availableTests.push(String(doc.monthly_test.test_name).trim());
  }
  const monthlyTest =
    selected?.monthly_test ||
    doc.monthly_test || { test_name: "", test_type: "", scholarship_scope: "none", obtained: 0, total: 100, note: "" };
  const nextFee = selected?.next_month_fee || doc.next_month_fee || {};
  return sendSuccess(res, {
    month_key: doc.month_key,
    subjects: doc.subjects || [],
    available_tests: [...new Set(availableTests)],
    available_test_entries: availableTestEntries,
    monthly_test: monthlyTest,
    next_month_fee: {
      ...nextFee,
      amount: Number(nextFee.final_fee || nextFee.amount || 0),
    },
    audit: selected?.audit || null,
  });
}

async function reportPdf(req, res) {
  const month_key = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.month_key);
  void month_key;
  return sendError(
    res,
    501,
    "NOT_IMPLEMENTED",
    "Server-side PDF reports are not implemented; generate client-side or add a PDF service."
  );
}

module.exports = { months, detail, reportPdf };
