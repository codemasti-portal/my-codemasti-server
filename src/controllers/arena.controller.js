const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const ArenaQuestion = require("../models/ArenaQuestion");
const ArenaSubmission = require("../models/ArenaSubmission");
const Student = require("../models/Student");

async function list(req, res) {
  const topic = String(req.query.topic || "").trim();
  const search = String(req.query.search || "").trim();
  const difficulty = String(req.query.difficulty || "").trim().toLowerCase();
  const statusFilter = String(req.query.status || "").trim().toLowerCase();

  // Get student's batch
  const student = await Student.findById(req.user.sub).select("batch batch_id").lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  const batchId = String(student.batch_id || student.batch || "").toLowerCase().trim();

  // Build filter conditions as an array for $and
  const filterConditions = [
    {
      $or: [
        { batch_id: batchId }, // Old format: single batch_id
        { batch_ids: { $in: [batchId] } }, // New format: array of batch_ids
      ],
    },
    // Exclude disabled questions from student view
    { $or: [{ is_disabled: false }, { is_disabled: { $exists: false } }] },
  ];

  if (topic) {
    filterConditions.push({ topic });
  }
  if (difficulty) {
    filterConditions.push({ difficulty });
  }
  if (search) {
    filterConditions.push({
      $or: [
        { title: { $regex: search, $options: "i" } },
        { topic: { $regex: search, $options: "i" } },
      ],
    });
  }

  // Combine all conditions with $and
  const filter = filterConditions.length === 1 ? filterConditions[0] : { $and: filterConditions };

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
  // Get student's batch
  const student = await Student.findById(req.user.sub).select("batch batch_id").lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  const batchId = String(student.batch_id || student.batch || "").toLowerCase().trim();

  // Find question and check if it's assigned to this batch
  const question = await ArenaQuestion.findOne({
    _id: req.params.questionId,
    $or: [
      { batch_id: batchId },
      { batch_ids: { $in: [batchId] } },
    ],
  }).lean();

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
    hidden_tests: question.hidden_tests || [],
    difficulty: question.difficulty,
    topic: question.topic,
    xp: question.xp,
    question_type: question.question_type || "coding",
    question_image_url: question.question_image_url,
    quiz_options: question.quiz_options || [],
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
    questionId: z.string().optional(),
    language: z.string().min(1),
    code: z.string().min(1),
  });
  const body = schema.parse(req.body);

  // Support questionId from body or route param
  const qId = req.params.questionId || body.questionId;
  const question = await ArenaQuestion.findById(qId).lean();
  if (!question) return sendError(res, 404, "QUESTION_NOT_FOUND", "Arena question not found");

  const isQuiz = String(question.question_type || "coding").toLowerCase() === "quiz";

  let status = "Wrong Answer";
  let xpAwarded = 0;
  let testCasesPassed = "0/1";

  if (isQuiz) {
    // Evaluate quiz client-submission using is_correct flag
    let selectedIdx = -1;
    try {
      const parsed = JSON.parse(body.code);
      selectedIdx = Number(parsed?.selected_option_index ?? -1);
    } catch { /* not JSON — wrong answer */ }

    const options = Array.isArray(question.quiz_options) ? question.quiz_options : [];
    const selectedOpt = selectedIdx >= 0 ? options[selectedIdx] : null;
    const isCorrect = Boolean(selectedOpt?.is_correct);

    status = isCorrect ? "Accepted" : "Wrong Answer";
    testCasesPassed = isCorrect ? "1/1" : "0/1";
  } else {
    // Coding/Written: simple mock grading (real judge not wired yet)
    const passed = Math.max(1, Math.min(12, Math.floor(Math.random() * 13)));
    const total = 12;
    status = passed >= 9 ? "Accepted" : "Wrong Answer";
    testCasesPassed = `${passed}/${total}`;
  }

  const submission = await ArenaSubmission.create({
    question_id: question._id,
    student_id: req.user.sub,
    language: body.language,
    code: body.code,
    status,
    test_cases_passed: testCasesPassed,
    execution_time_ms: isQuiz ? 0 : 90 + Math.floor(Math.random() * 80),
    memory_mb: isQuiz ? 0 : 24 + Math.floor(Math.random() * 10),
    submitted_at: new Date(),
  });

  // Award XP only if accepted and first time solving
  if (status === "Accepted") {
    const previousAccepted = await ArenaSubmission.findOne({
      question_id: question._id,
      student_id: req.user.sub,
      status: "Accepted",
      _id: { $ne: submission._id },
    });

    if (!previousAccepted) {
      xpAwarded = question.xp || 20;
      // Add XP to student profile
      await Student.findByIdAndUpdate(req.user.sub, { $inc: { xp: xpAwarded } });
    }
  }

  return sendSuccess(res, {
    submission_id: String(submission._id),
    status: submission.status,
    test_cases_passed: submission.test_cases_passed,
    execution_time_ms: submission.execution_time_ms,
    memory_mb: submission.memory_mb,
    submitted_at: submission.submitted_at,
    xpAwarded,
    xp_awarded: xpAwarded,
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
  // Return full calendar year worth of data (Jan 1 to Dec 31 of current year)
  const now = new Date();
  const year = Number(req.query.year || now.getFullYear());
  const start = new Date(`${year}-01-01T00:00:00.000Z`);
  const end = new Date(`${year}-12-31T23:59:59.999Z`);

  const rows = await ArenaSubmission.find({
    student_id: req.user.sub,
    submitted_at: { $gte: start, $lte: end },
  })
    .select("submitted_at")
    .lean();

  const daily_counts = {};
  for (const row of rows) {
    // Use ISO date string sliced to YYYY-MM-DD for consistent date keys
    const d = new Date(row.submitted_at).toISOString().slice(0, 10);
    daily_counts[d] = (daily_counts[d] || 0) + 1;
  }

  return sendSuccess(res, daily_counts);
}

async function solved(req, res) {
  const student = await Student.findById(req.user.sub).select("batch batch_id").lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  const batchId = String(student.batch_id || student.batch || "").toLowerCase().trim();

  // Support both old single batch_id and new batch_ids array format
  const questions = await ArenaQuestion.find({
    $or: [{ batch_id: batchId }, { batch_ids: { $in: [batchId] } }],
  })
    .select("_id")
    .lean();
  const qIds = questions.map((q) => q._id);

  const acceptedSubs = await ArenaSubmission.find({
    question_id: { $in: qIds },
    student_id: req.user.sub,
    status: "Accepted",
  })
    .select("question_id")
    .lean();

  const solvedIds = [...new Set(acceptedSubs.map((s) => String(s.question_id)))];
  return sendSuccess(res, solvedIds);
}

module.exports = { list, detail, run, submit, submissions, activity, solved };

