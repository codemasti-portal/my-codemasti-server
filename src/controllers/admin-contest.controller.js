const crypto = require("crypto");
const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Contest = require("../models/Contest");
const ScorecardTest = require("../models/ScorecardTest");
const { toAdminContestRow, loadTestsMap, normalizeBatchId } = require("../services/contest.service");

const urlSchema = z.string().trim().url().max(2000).refine((u) => /^https:\/\//i.test(u), {
  message: "URL must use https://",
});

function parseDate(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function validateSchedule(show_from, start_at, end_at) {
  const sf = parseDate(show_from);
  const st = parseDate(start_at);
  const en = parseDate(end_at);
  if (!sf || !st || !en) return { ok: false, message: "Invalid date values" };
  if (sf.getTime() > st.getTime()) {
    return { ok: false, message: "Show from must be at or before start time" };
  }
  if (st.getTime() >= en.getTime()) {
    return { ok: false, message: "Start must be before end" };
  }
  return { ok: true, dates: { show_from: sf, start_at: st, end_at: en } };
}

const createSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  test_id: z.string().min(1),
  batch_id: z.string().min(1).max(40).trim(),
  section_ids: z.array(z.string().trim()).optional().default([]),
  show_from: z.union([z.string(), z.date()]),
  start_at: z.union([z.string(), z.date()]),
  end_at: z.union([z.string(), z.date()]),
  platform_url: urlSchema,
  event_group_id: z.string().trim().optional(),
  is_published: z.boolean().optional().default(false),
});

const patchSchema = createSchema.partial();

const bulkSchema = z.object({
  test_id: z.string().min(1),
  event_group_id: z.string().trim().optional(),
  is_published: z.boolean().optional().default(false),
  contests: z
    .array(
      z.object({
        title: z.string().min(1).max(200).trim(),
        batch_id: z.string().min(1).max(40).trim(),
        section_ids: z.array(z.string().trim()).optional().default([]),
        show_from: z.union([z.string(), z.date()]),
        start_at: z.union([z.string(), z.date()]),
        end_at: z.union([z.string(), z.date()]),
        platform_url: urlSchema,
      })
    )
    .min(1)
    .max(20),
});

async function assertTestExists(testId) {
  if (!mongoose.Types.ObjectId.isValid(testId)) return null;
  return ScorecardTest.findById(testId).lean();
}

async function listContests(req, res) {
  const schema = z.object({
    batch_id: z.string().optional(),
    test_id: z.string().optional(),
    published_only: z.enum(["0", "1", "true", "false"]).optional(),
  });
  const parsed = schema.safeParse(req.query);
  const q = parsed.success ? parsed.data : {};
  const filter = {};
  if (q.batch_id) filter.batch_id = normalizeBatchId(q.batch_id);
  if (q.test_id && mongoose.Types.ObjectId.isValid(q.test_id)) {
    filter.test_id = new mongoose.Types.ObjectId(q.test_id);
  }
  if (/^(1|true)$/i.test(String(q.published_only || ""))) {
    filter.is_published = true;
  }

  const rows = await Contest.find(filter).sort({ start_at: -1, createdAt: -1 }).lean();
  const tests = await loadTestsMap(rows.map((r) => r.test_id));
  const now = new Date();
  return sendSuccess(res, rows.map((r) => toAdminContestRow(r, tests.get(String(r.test_id)), now)));
}

async function getContest(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid contest id");
  }
  const row = await Contest.findById(req.params.id).lean();
  if (!row) return sendError(res, 404, "NOT_FOUND", "Contest not found");
  const tests = await loadTestsMap([row.test_id]);
  return sendSuccess(res, toAdminContestRow(row, tests.get(String(row.test_id)), new Date()));
}

async function createContest(req, res) {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const body = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(body.test_id)) {
    return sendError(res, 400, "INVALID_TEST", "Invalid test id");
  }
  const test = await assertTestExists(body.test_id);
  if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Scorecard test not found");

  const sched = validateSchedule(body.show_from, body.start_at, body.end_at);
  if (!sched.ok) return sendError(res, 400, "VALIDATION_ERROR", sched.message);

  const isPublished = Boolean(body.is_published);
  const doc = await Contest.create({
    title: body.title,
    test_id: new mongoose.Types.ObjectId(body.test_id),
    batch_id: normalizeBatchId(body.batch_id),
    section_ids: (body.section_ids || []).map(normalizeBatchId).filter(Boolean),
    show_from: sched.dates.show_from,
    start_at: sched.dates.start_at,
    end_at: sched.dates.end_at,
    platform_url: body.platform_url.trim(),
    event_group_id: body.event_group_id || crypto.randomUUID(),
    is_published: isPublished,
    published_at: isPublished ? new Date() : null,
    created_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
    updated_by_staff_id: req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null,
  });

  return sendSuccess(res, toAdminContestRow(doc.toObject(), test, new Date()), "Contest created");
}

async function bulkCreateContests(req, res) {
  const parsed = bulkSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const body = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(body.test_id)) {
    return sendError(res, 400, "INVALID_TEST", "Invalid test id");
  }
  const test = await assertTestExists(body.test_id);
  if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Scorecard test not found");

  const groupId = body.event_group_id || crypto.randomUUID();
  const isPublished = Boolean(body.is_published);
  const now = new Date();
  const staffId = req.staff?.sub ? new mongoose.Types.ObjectId(req.staff.sub) : null;
  const created = [];

  for (const row of body.contests) {
    const sched = validateSchedule(row.show_from, row.start_at, row.end_at);
    if (!sched.ok) {
      return sendError(res, 400, "VALIDATION_ERROR", `${row.batch_id}: ${sched.message}`);
    }
    const doc = await Contest.create({
      title: row.title,
      test_id: new mongoose.Types.ObjectId(body.test_id),
      batch_id: normalizeBatchId(row.batch_id),
      section_ids: (row.section_ids || []).map(normalizeBatchId).filter(Boolean),
      show_from: sched.dates.show_from,
      start_at: sched.dates.start_at,
      end_at: sched.dates.end_at,
      platform_url: row.platform_url.trim(),
      event_group_id: groupId,
      is_published: isPublished,
      published_at: isPublished ? now : null,
      created_by_staff_id: staffId,
      updated_by_staff_id: staffId,
    });
    created.push(toAdminContestRow(doc.toObject(), test, now));
  }

  return sendSuccess(res, { event_group_id: groupId, contests: created }, "Contests scheduled");
}

async function patchContest(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid contest id");
  }
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const msg = parsed.error?.issues?.[0]?.message || "Invalid body";
    return sendError(res, 400, "VALIDATION_ERROR", msg);
  }
  const body = parsed.data;
  const doc = await Contest.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Contest not found");

  const show_from = body.show_from !== undefined ? body.show_from : doc.show_from;
  const start_at = body.start_at !== undefined ? body.start_at : doc.start_at;
  const end_at = body.end_at !== undefined ? body.end_at : doc.end_at;
  const sched = validateSchedule(show_from, start_at, end_at);
  if (!sched.ok) return sendError(res, 400, "VALIDATION_ERROR", sched.message);

  if (body.title !== undefined) doc.title = body.title;
  if (body.test_id !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(body.test_id)) {
      return sendError(res, 400, "INVALID_TEST", "Invalid test id");
    }
    const test = await assertTestExists(body.test_id);
    if (!test) return sendError(res, 404, "TEST_NOT_FOUND", "Scorecard test not found");
    doc.test_id = new mongoose.Types.ObjectId(body.test_id);
  }
  if (body.batch_id !== undefined) doc.batch_id = normalizeBatchId(body.batch_id);
  if (body.section_ids !== undefined) {
    doc.section_ids = body.section_ids.map(normalizeBatchId).filter(Boolean);
  }
  doc.show_from = sched.dates.show_from;
  doc.start_at = sched.dates.start_at;
  doc.end_at = sched.dates.end_at;
  if (body.platform_url !== undefined) doc.platform_url = body.platform_url.trim();
  if (body.event_group_id !== undefined) doc.event_group_id = body.event_group_id;
  if (body.is_published !== undefined) {
    const wasPublished = doc.is_published;
    doc.is_published = body.is_published;
    if (body.is_published && !wasPublished) doc.published_at = new Date();
    if (!body.is_published) doc.published_at = null;
  }

  if (req.staff?.sub) doc.updated_by_staff_id = new mongoose.Types.ObjectId(req.staff.sub);
  await doc.save();

  const test = await ScorecardTest.findById(doc.test_id).lean();
  return sendSuccess(res, toAdminContestRow(doc.toObject(), test, new Date()), "Contest updated");
}

async function deleteContest(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid contest id");
  }
  const r = await Contest.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Contest not found");
  return sendSuccess(res, { id: req.params.id }, "Contest deleted");
}

module.exports = {
  listContests,
  getContest,
  createContest,
  bulkCreateContests,
  patchContest,
  deleteContest,
};
