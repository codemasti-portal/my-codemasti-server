const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const ArenaQuestion = require("../models/ArenaQuestion");
const ArenaSubmission = require("../models/ArenaSubmission");

async function list(req, res) {
  const topic = String(req.query.topic || "").trim();
  const search = String(req.query.search || "").trim();
  const difficulty = String(req.query.difficulty || "").trim().toLowerCase();
  const statusFilter = String(req.query.status || "").trim().toLowerCase();

  const filter = {};
  if (topic) filter.topic = topic;
  if (difficulty) filter.difficulty = difficulty;
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { topic: { $regex: search, $options: "i" } },
    ];
  }

  const questions = await ArenaQuestion.find(filter).sort({ number: 1 }).lean();
  const qIds = questions.map((q) => q._id);
  const latestSubs = qIds.length
    ? await ArenaSubmission.find({ question_id: { $in: qIds }, student_id: req.user.sub })
        .sort({ submitted_at: -1 })
        .lean()
    : [];
  const latestByQ = new Map();
  for (const s of latestSubs) {
    const k = String(s.question_id);
    if (!latestByQ.has(k)) latestByQ.set(k, s);
  }

  const items = questions.map((q) => {
    const latest = latestByQ.get(String(q._id));
    const st = latest?.status?.toLowerCase() === "accepted" ? "solved" : "unsolved";
    return {
      id: String(q._id),
      number: q.number,
      title: q.title,
      subject: q.subject,
      topic: q.topic,
      difficulty: q.difficulty,
      status: st,
      xp: q.xp,
      acceptance_rate: q.acceptance_rate,
    };
  });

  const filtered =
    statusFilter && ["solved", "unsolved"].includes(statusFilter)
      ? items.filter((i) => i.status === statusFilter)
      : items;

  return sendSuccess(res, filtered);
}

async function detail(req, res) {
  const question = await ArenaQuestion.findById(req.params.questionId).lean();
  if (!question) return sendError(res, 404, "QUESTION_NOT_FOUND", "Arena question not found");

  return sendSuccess(res, {
    id: String(question._id),
    title: question.title,
    description: question.description,
    requirements: question.requirements || [],
    input_format: question.input_format,
    output_format: question.output_format,
    constraints: question.constraints || [],
    examples: question.examples || [],
    time_limit: question.time_limit,
    memory_limit: question.memory_limit,
    starter_code: question.starter_code || {},
  });
}

function run(req, res) {
  const schema = z.object({
    language: z.string().min(1),
    code: z.string().min(1),
    stdin: z.string().optional().default(""),
  });
  schema.parse(req.body);
  return sendSuccess(res, {
    stdout: "",
    stderr: "",
    execution_time_ms: 80,
    memory_mb: 24,
    status: "SUCCESS",
  });
}

async function submit(req, res) {
  const schema = z.object({
    language: z.string().min(1),
    code: z.string().min(1),
  });
  const body = schema.parse(req.body);

  const question = await ArenaQuestion.findById(req.params.questionId).lean();
  if (!question) return sendError(res, 404, "QUESTION_NOT_FOUND", "Arena question not found");

  const passed = Math.max(1, Math.min(12, Math.floor(Math.random() * 13)));
  const total = 12;
  const status = passed >= 9 ? "Accepted" : "Wrong Answer";

  const submission = await ArenaSubmission.create({
    question_id: question._id,
    student_id: req.user.sub,
    language: body.language,
    code: body.code,
    status,
    test_cases_passed: `${passed}/${total}`,
    execution_time_ms: 90 + Math.floor(Math.random() * 80),
    memory_mb: 24 + Math.floor(Math.random() * 10),
    submitted_at: new Date(),
  });

  return sendSuccess(res, {
    submission_id: String(submission._id),
    status: submission.status,
    test_cases_passed: submission.test_cases_passed,
    execution_time_ms: submission.execution_time_ms,
    memory_mb: submission.memory_mb,
    submitted_at: submission.submitted_at,
  });
}

async function submissions(req, res) {
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const skip = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    ArenaSubmission.find({ question_id: req.params.questionId, student_id: req.user.sub })
      .sort({ submitted_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ArenaSubmission.countDocuments({ question_id: req.params.questionId, student_id: req.user.sub }),
  ]);

  const items = docs.map((doc) => ({
    submission_id: String(doc._id),
    status: doc.status,
    test_cases_passed: doc.test_cases_passed,
    submitted_at: doc.submitted_at,
  }));

  return sendSuccess(res, items, "", { page, limit, total });
}

async function activity(req, res) {
  const range = String(req.query.range || "year");
  const start = new Date();
  if (range === "year") {
    start.setUTCFullYear(start.getUTCFullYear() - 1);
  } else if (range === "month") {
    start.setUTCMonth(start.getUTCMonth() - 1);
  } else {
    start.setUTCDate(start.getUTCDate() - 30);
  }

  const rows = await ArenaSubmission.find({
    student_id: req.user.sub,
    submitted_at: { $gte: start },
  })
    .select("submitted_at")
    .lean();

  const daily_counts = {};
  for (const row of rows) {
    const d = new Date(row.submitted_at).toISOString().slice(0, 10);
    daily_counts[d] = (daily_counts[d] || 0) + 1;
  }

  return sendSuccess(res, { daily_counts });
}

module.exports = { list, detail, run, submit, submissions, activity };
