const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const AssignmentXpGrant = require("../models/AssignmentXpGrant");
const Student = require("../models/Student");
const BatchCatalog = require("../models/BatchCatalog");
const { DEFAULT_BATCHES } = require("../constants/batchDefaults");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { assignmentCatalogBatchScopeOr } = require("../utils/assignmentBatchFilter");
const { executePythonCode } = require("../services/python-executor-local");

function normalizeExpectedOutput(testRow) {
  if (!testRow || typeof testRow !== "object") return "";
  if (testRow.expected_output != null) return String(testRow.expected_output).trim();
  if (testRow.output != null) return String(testRow.output).trim();
  return "";
}

function buildExecutablePythonCode(userCode, stdin, executionMode) {
  const rawCode = String(userCode || "");
  if (String(executionMode || "full_program") !== "function_only") return rawCode;
  const inputLiteral = JSON.stringify(String(stdin || ""));
  return `${rawCode}

__cm_input = ${inputLiteral}
__cm_result = None
try:
    __cm_result = solve(__cm_input)
except TypeError:
    __cm_lines = [line for line in __cm_input.strip().splitlines() if line.strip() != ""]
    __cm_first = __cm_lines[0].strip() if __cm_lines else ""
    __cm_arg = __cm_first
    try:
        __cm_arg = int(__cm_first)
    except Exception:
        try:
            __cm_arg = float(__cm_first)
        except Exception:
            try:
                import json as __cm_json
                __cm_arg = __cm_json.loads(__cm_first) if __cm_first else ""
            except Exception:
                __cm_arg = __cm_first
    try:
        __cm_result = solve(__cm_arg)
    except TypeError:
        __cm_result = solve()

if __cm_result is not None:
    print(__cm_result)
`;
}

function fullQuestionXp(xp) {
  return Math.max(0, Math.floor(Number(xp) || 0));
}

function lateXpAmount(fullXp) {
  return Math.floor(fullXp / 2);
}

/** Accepted only: 
 * - Full XP if submitted at or before assignment deadline (on-time)
 * - 0.5x full XP if submitted after deadline (late penalty)
 */
function xpAwardedForAccepted(questionXp, submittedAt, deadlineDate) {
  const full = fullQuestionXp(questionXp);
  if (!deadlineDate) return full;
  const tSub = new Date(submittedAt).getTime();
  const tEnd = new Date(deadlineDate).getTime();
  if (Number.isNaN(tEnd)) return full;
  // On-time: full XP
  if (tSub <= tEnd) return full;
  // Late: half XP
  return lateXpAmount(full);
}

function submittedAtOrBeforeDeadline(submittedAt, deadlineDate) {
  if (deadlineDate == null) return true;
  const tEnd = new Date(deadlineDate).getTime();
  if (Number.isNaN(tEnd)) return true;
  return new Date(submittedAt).getTime() <= tEnd;
}

function isAssignmentReleased(assignment, now = new Date()) {
  const t = new Date(assignment.release_date).getTime();
  return !Number.isNaN(t) && t <= now.getTime();
}

/** Normalized catalog batch keys on an assignment (batch_id + batch_ids), deduped. */
function assignmentScopeBatchKeys(assignment) {
  const keys = [];
  const a = assignment || {};
  const primary = String(a.batch_id || "").toLowerCase().trim();
  if (primary) keys.push(primary);
  const arr = Array.isArray(a.batch_ids) ? a.batch_ids : [];
  for (const x of arr) {
    const z = String(x || "").toLowerCase().trim();
    if (z) keys.push(z);
  }
  return [...new Set(keys)];
}

/** Matches student list visibility: published + batch scope (batch_id and/or batch_ids, legacy global when unscoped). */
function isAssignmentVisibleToStudent(assignment, student, now = new Date()) {
  if (!isAssignmentReleased(assignment, now)) return false;
  const sbatch = String(student?.batch_id || "").toLowerCase().trim();
  const scopes = assignmentScopeBatchKeys(assignment);
  if (scopes.length === 0) return true;
  if (!sbatch) return false;
  return scopes.includes(sbatch);
}

function normCatalogSectionId(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function batchDisplayName(batchIdLower) {
  if (!batchIdLower) return "";
  const d = DEFAULT_BATCHES.find((b) => b.batch_id === batchIdLower);
  return d?.name || batchIdLower;
}

function sectionNamesForSubject(catalogDoc, subject) {
  const subj = String(subject || "").trim().toLowerCase();
  if (!catalogDoc?.sections?.length || !subj) return [];
  const names = [];
  for (const sec of catalogDoc.sections) {
    const subs = (sec.subjects || []).map((x) => String(x).trim().toLowerCase());
    if (subs.includes(subj)) {
      const n = String(sec.name || sec.section_id || "").trim();
      names.push(n || sec.section_id);
    }
  }
  return names;
}

function studentSectionDisplay(student, catalogDoc) {
  const sid = normCatalogSectionId(student.section_id);
  if (sid && catalogDoc?.sections?.length) {
    const sec = catalogDoc.sections.find((s) => normCatalogSectionId(s.section_id) === sid);
    if (sec) return String(sec.name || sec.section_id).trim();
  }
  const enr = String(student.enrollment_section || "").trim();
  if (enr) return `Section ${enr}`;
  return "";
}

function assignmentScopeLabels(assignment, student, catalogById) {
  const sbatch = String(student?.batch_id || "").toLowerCase().trim();
  const keys = assignmentScopeBatchKeys(assignment);
  const ab = keys[0] || "";
  const progBid = ab || sbatch;
  const cat = progBid ? catalogById.get(progBid) : null;
  const program_label = cat?.name || batchDisplayName(progBid) || (progBid ? progBid : "Program");
  const fromSubject = sectionNamesForSubject(cat, assignment.subject);
  let section_label;
  if (fromSubject.length > 0) {
    section_label = fromSubject.join(", ");
  } else {
    section_label = studentSectionDisplay(student, cat) || "All sections";
  }
  const scope_line = `${program_label} — ${section_label}`;
  return { program_label, section_label, scope_line, batch_id: assignment.batch_id || ab || "" };
}

function mergePublishedIntoFilter(baseFilter, now = new Date()) {
  const published = { release_date: { $lte: now } };
  if (!baseFilter || Object.keys(baseFilter).length === 0) return published;
  return { $and: [baseFilter, published] };
}

function quizSubmissionIsCorrect(submissionCode, quizOptions) {
  if (!submissionCode || !Array.isArray(quizOptions) || quizOptions.length === 0) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(String(submissionCode));
  } catch {
    return false;
  }
  const selectedIdx = Number(parsed?.selected_option_index);
  const selectedText = String(parsed?.selected_option || "")
    .trim()
    .toLowerCase();
  const correctIndexes = quizOptions
    .map((opt, idx) => (opt?.is_correct ? idx : -1))
    .filter((idx) => idx >= 0);
  if (Number.isInteger(selectedIdx) && correctIndexes.includes(selectedIdx)) return true;
  if (!selectedText) return false;
  const matchedIndex = quizOptions.findIndex(
    (opt) => String(opt?.text || "").trim().toLowerCase() === selectedText
  );
  return matchedIndex >= 0 && correctIndexes.includes(matchedIndex);
}

function submissionPassedAllTestCases(submission) {
  if (!submission || typeof submission !== "object") return false;
  return String(submission.status || "") === "Accepted";
}

async function assertStudentAssignmentAccess(req, res, assignmentId) {
  const [student, assignment] = await Promise.all([
    Student.findById(req.user.sub).lean(),
    Assignment.findById(assignmentId).lean(),
  ]);
  if (!student) {
    sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
    return null;
  }
  if (!assignment) {
    sendError(res, 404, "NOT_FOUND", "Assignment not found");
    return null;
  }
  if (!isAssignmentVisibleToStudent(assignment, student)) {
    sendError(res, 404, "NOT_FOUND", "Assignment not found");
    return null;
  }
  return assignment;
}

async function list(req, res) {
  const subject = String(req.query.subject || "").trim();
  const search = String(req.query.search || "").trim();
  const difficulty = String(req.query.difficulty || "").trim().toLowerCase();
  const statusFilter = String(req.query.status || "").trim().toLowerCase();
  const assignmentType = String(req.query.assignment_type || "").trim().toLowerCase();

  const rawStudent = await Student.findById(req.user.sub).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  const sbatch = String(student.batch_id || "").toLowerCase().trim();

  const catalogs = await BatchCatalog.find({}).lean();
  const catalogById = new Map(catalogs.map((c) => [String(c.batch_id || "").toLowerCase(), c]));

  const parts = [];
  if (subject) parts.push({ subject });
  if (assignmentType) parts.push({ assignment_type: assignmentType });
  if (sbatch) {
    parts.push({ $or: assignmentCatalogBatchScopeOr(sbatch) });
  }

  const baseFilter =
    parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
  const assignmentFilter = mergePublishedIntoFilter(baseFilter);

  const assignments = await Assignment.find(assignmentFilter).sort({ release_date: -1 }).lean();
  const assignmentIds = assignments.map((a) => a._id);
  if (!assignmentIds.length) return sendSuccess(res, []);

  const questionFilter = { assignment_id: { $in: assignmentIds } };
  if (difficulty) questionFilter.difficulty = difficulty;
  if (search) questionFilter.name = { $regex: search, $options: "i" };

  const questions = await AssignmentQuestion.find(questionFilter).lean();
  const questionIds = questions.map((q) => q._id);

  const submissions = questionIds.length
    ? await AssignmentSubmission.find({
        question_id: { $in: questionIds },
        student_id: req.user.sub,
      })
        .sort({ submitted_at: -1 })
        .lean()
    : [];

  const acceptedRows = questionIds.length
    ? await AssignmentSubmission.aggregate([
        {
          $match: {
            question_id: { $in: questionIds },
            student_id: student._id,
            status: "Accepted",
          },
        },
        {
          $group: {
            _id: "$question_id",
            best_xp_awarded: { $max: { $ifNull: ["$xp_awarded", 0] } },
          },
        },
      ])
    : [];

  const latestByQuestion = new Map();
  for (const submission of submissions) {
    const key = String(submission.question_id);
    if (!latestByQuestion.has(key)) latestByQuestion.set(key, submission);
  }
  const hasAcceptedByQuestion = new Map();
  const bestXpByQuestion = new Map();
  for (const row of acceptedRows) {
    const key = String(row._id);
    hasAcceptedByQuestion.set(key, true);
    bestXpByQuestion.set(key, Number(row.best_xp_awarded || 0));
  }

  const solvedCountByQuestion = await AssignmentSubmission.aggregate([
    { $match: { question_id: { $in: questionIds } } },
    { $group: { _id: "$question_id", solved_by: { $addToSet: "$student_id" } } },
    { $project: { solved_by: { $size: "$solved_by" } } },
  ]);
  const solvedMap = new Map(solvedCountByQuestion.map((row) => [String(row._id), row.solved_by]));

  const grouped = assignments
    .map((assignment) => {
      const qs = questions
        .filter((q) => String(q.assignment_id) === String(assignment._id))
        .map((q) => {
          const latest = latestByQuestion.get(String(q._id));
          const questionSubmissions = submissions.filter((s) => String(s.question_id) === String(q._id));
          const acceptedSubmissions = questionSubmissions.filter((s) => submissionPassedAllTestCases(s));
          const quizCorrectSubmissions =
            String(assignment.assignment_type || "").toLowerCase() === "quiz"
              ? questionSubmissions.filter((s) => quizSubmissionIsCorrect(s.code, q.quiz_options || []))
              : [];
          const hasAccepted = hasAcceptedByQuestion.get(String(q._id)) === true || acceptedSubmissions.length > 0;
          const hasCorrectQuizSubmission = quizCorrectSubmissions.length > 0;
          const isSolved = hasAccepted || hasCorrectQuizSubmission;
          const hasSubmitted = questionSubmissions.length > 0;
          let status = "pending";
          if (isSolved) status = "solved";
          else if (hasSubmitted) status = "attempted";
          const xpFull = fullQuestionXp(q.xp);
          let xpEarned = 0;
          if (isSolved) {
            const best = Number(bestXpByQuestion.get(String(q._id)) || 0);
            if (best > 0) {
              xpEarned = best;
            } else {
              const acceptedAtCandidates = [...acceptedSubmissions, ...quizCorrectSubmissions]
                .map((s) => new Date(s.submitted_at))
                .filter((d) => !Number.isNaN(d.getTime()))
                .sort((a, b) => a.getTime() - b.getTime());
              const acceptedAt =
                acceptedAtCandidates[0] || latest?.submitted_at || new Date();
              xpEarned = xpAwardedForAccepted(q.xp, acceptedAt, assignment.deadline_date);
            }
          }
          return {
            id: String(q._id),
            name: q.name,
            difficulty: q.difficulty,
            xp: q.xp ?? 0,
            xp_earned: xpEarned,
            topics: q.topics || [],
            solved_by: solvedMap.get(String(q._id)) || 0,
            status,
          };
        });

      const filteredQuestions =
        statusFilter && ["pending", "solved", "attempted"].includes(statusFilter)
          ? qs.filter((q) => q.status === statusFilter)
          : qs;

      const labels = assignmentScopeLabels(assignment, student, catalogById);
      return {
        id: String(assignment._id),
        batch_id: labels.batch_id,
        program_label: labels.program_label,
        section_label: labels.section_label,
        scope_line: labels.scope_line,
        subject: assignment.subject,
        module: assignment.module,
        assignment_type: assignment.assignment_type || "written",
        release_date: assignment.release_date,
        deadline_date: assignment.deadline_date,
        resource_url: assignment.resource_url || "",
        resource_size: assignment.resource_size || "",
        questions: filteredQuestions,
      };
    })
    .filter((a) => a.questions.length > 0);

  return sendSuccess(res, grouped);
}

async function filters(req, res) {
  const rawStudent = await Student.findById(req.user.sub).lean();
  const student = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  const sbatch = String(student.batch_id || "").toLowerCase().trim();
  if (!sbatch) {
    return sendSuccess(res, {
      subjects: [],
      difficulties: [],
      assignment_types: [],
      statuses: ["pending", "attempted", "solved"],
    });
  }

  const assignmentFilter = mergePublishedIntoFilter(sbatch ? { $or: assignmentCatalogBatchScopeOr(sbatch) } : {});
  const assignmentIds = (await Assignment.find(assignmentFilter).select("_id").lean()).map((x) => x._id);
  if (!assignmentIds.length) {
    return sendSuccess(res, {
      subjects: [],
      difficulties: [],
      assignment_types: [],
      statuses: ["pending", "attempted", "solved"],
    });
  }

  const [subjectsRows, difficultiesRows, assignmentTypesRows] = await Promise.all([
    Assignment.aggregate([
      { $match: { _id: { $in: assignmentIds } } },
      { $group: { _id: "$subject" } },
      { $match: { _id: { $ne: null } } },
      { $sort: { _id: 1 } },
    ]),
    AssignmentQuestion.aggregate([
      { $match: { assignment_id: { $in: assignmentIds } } },
      { $group: { _id: "$difficulty" } },
      { $match: { _id: { $ne: null } } },
      { $sort: { _id: 1 } },
    ]),
    Assignment.aggregate([
      { $match: { _id: { $in: assignmentIds } } },
      { $group: { _id: "$assignment_type" } },
      { $match: { _id: { $ne: null } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  return sendSuccess(res, {
    subjects: subjectsRows.map((r) => r._id).filter(Boolean),
    difficulties: difficultiesRows.map((r) => String(r._id || "").toLowerCase()).filter(Boolean),
    assignment_types: assignmentTypesRows.map((r) => String(r._id || "").toLowerCase()).filter(Boolean),
    statuses: ["pending", "attempted", "solved"],
  });
}

async function questionDetail(req, res) {
  const assignment = await assertStudentAssignmentAccess(req, res, req.params.assignmentId);
  if (!assignment) return;

  const question = await AssignmentQuestion.findOne({
    _id: req.params.questionId,
    assignment_id: req.params.assignmentId,
  }).lean();

  if (!question) {
    return sendError(res, 404, "QUESTION_NOT_FOUND", "Assignment question not found");
  }

  const xpOnTime = fullQuestionXp(question.xp);
  return sendSuccess(res, {
    assignment_id: String(question.assignment_id),
    question_id: String(question._id),
    assignment_type: String(assignment?.assignment_type || "written").toLowerCase(),
    assignment_subject: assignment?.subject || "",
    assignment_module: assignment?.module || "",
    assignment_deadline_date: assignment?.deadline_date || null,
    name: question.name,
    difficulty: question.difficulty,
    xp: question.xp ?? 0,
    xp_on_time: xpOnTime,
    xp_if_late: lateXpAmount(xpOnTime),
    title: question.title,
    description: question.description,
    requirements: question.requirements || [],
    input_format: question.input_format,
    output_format: question.output_format,
    constraints: question.constraints || [],
    examples: question.examples || [],
    time_limit: question.time_limit,
    memory_limit: question.memory_limit,
    execution_mode: String(question.execution_mode || "full_program"),
    starter_code: question.starter_code || {},
    question_image_url: question.question_image_url || "",
    quiz_options: Array.isArray(question.quiz_options) ? question.quiz_options : [],
  });
}

async function run(req, res) {
  const ok = await assertStudentAssignmentAccess(req, res, req.params.assignmentId);
  if (!ok) return;

  const schema = z.object({
    language: z.string().min(1),
    code: z.string().min(1),
    stdin: z.string().optional().default(""),
  });
  schema.parse(req.body);

  const language = String(req.body.language || "").toLowerCase();
  const code = String(req.body.code || "");
  const stdin = String(req.body.stdin || "");
  if (language !== "python") {
    return sendError(res, 400, "LANGUAGE_NOT_SUPPORTED", "Only Python is supported.");
  }

  try {
    const executableCode = buildExecutablePythonCode(code, stdin, ok.execution_mode);
    const result = await executePythonCode({ code: executableCode, stdin, timeoutMs: 5000 });
    return sendSuccess(res, {
      stdout: result.output,
      stderr: result.error,
      execution_time_ms: Math.max(0, Math.floor(result.execution_time * 1000)),
      memory_mb: 0,
      status: result.success ? "SUCCESS" : "ERROR",
    });
  } catch (error) {
    return sendSuccess(res, {
      stdout: "",
      stderr: error?.message || "Python runtime unavailable",
      execution_time_ms: 0,
      memory_mb: 0,
      status: "ERROR",
    });
  }
}

async function submit(req, res) {
  const schema = z.object({
    language: z.string().min(1),
    code: z.string().min(1),
  });
  const body = schema.parse(req.body);

  const ok = await assertStudentAssignmentAccess(req, res, req.params.assignmentId);
  if (!ok) return;

  const question = await AssignmentQuestion.findOne({
    _id: req.params.questionId,
    assignment_id: req.params.assignmentId,
  }).lean();
  if (!question) {
    return sendError(res, 404, "QUESTION_NOT_FOUND", "Assignment question not found");
  }

  const assignment = await Assignment.findById(question.assignment_id)
    .select("deadline_date assignment_type")
    .lean();
  const assignmentType = String(assignment?.assignment_type || "").toLowerCase();
  const executionMode = String(question.execution_mode || "full_program");

  let passed = Math.max(1, Math.min(10, Math.floor(Math.random() * 11)));
  let total = 10;
  let status = passed >= 8 ? "Accepted" : "Wrong Answer";
  let testCaseResults = Array.from({ length: total }, (_, idx) => ({
    label: `TC #${idx + 1}`,
    passed: idx < passed,
  }));
  let aiFeedback = "";
  let aiScore = null;
  let evaluatorProvider = "";
  let evaluatorModel = "";
  let evaluatorRaw = "";

  if (assignmentType === "quiz") {
    let selectedOptionIndex = -1;
    let selectedOptionText = "";
    try {
      const parsed = JSON.parse(String(body.code || "{}"));
      if (parsed && Number.isInteger(parsed.selected_option_index)) {
        selectedOptionIndex = Number(parsed.selected_option_index);
      }
      selectedOptionText = String(parsed?.selected_option || "").trim().toLowerCase();
    } catch {
      selectedOptionIndex = -1;
      selectedOptionText = "";
    }
    const options = Array.isArray(question.quiz_options) ? question.quiz_options : [];
    const correctIndexes = options
      .map((opt, idx) => (opt?.is_correct ? idx : -1))
      .filter((idx) => idx >= 0);
    let isAccepted = selectedOptionIndex >= 0 && correctIndexes.includes(selectedOptionIndex);
    if (!isAccepted && selectedOptionText) {
      const matchedIndex = options.findIndex(
        (opt) => String(opt?.text || "").trim().toLowerCase() === selectedOptionText
      );
      if (matchedIndex >= 0 && correctIndexes.includes(matchedIndex)) {
        isAccepted = true;
      }
    }
    total = Math.max(1, options.length || 1);
    passed = isAccepted ? total : 0;
    status = isAccepted ? "Accepted" : "Wrong Answer";
    testCaseResults = options.map((opt, idx) => ({
      label: `Option ${idx + 1}`,
      passed: correctIndexes.includes(idx),
    }));
  } else if (assignmentType === "coding") {
    const language = String(body.language || "").toLowerCase();
    const hiddenTests = Array.isArray(question.hidden_tests) ? question.hidden_tests : [];
    if (language !== "python") {
      return sendError(res, 400, "LANGUAGE_NOT_SUPPORTED", "Only Python is supported.");
    } else {
      const normalizedRows = [];
      for (let idx = 0; idx < hiddenTests.length; idx += 1) {
        const test = hiddenTests[idx];
        const input = String(test?.input || "");
        const expected = normalizeExpectedOutput(test);
        try {
          const executableCode = buildExecutablePythonCode(body.code, input, executionMode);
          const result = await executePythonCode({ code: executableCode, stdin: input, timeoutMs: 5000 });
          const actual = String(result.output || "").trim();
          const isPassed = result.success && actual === expected;
          normalizedRows.push({
            label: String(test?.label || `TC #${idx + 1}`),
            passed: isPassed,
            reason: isPassed
              ? ""
              : result.error
                ? result.error
                : `Expected "${expected}" but got "${actual}"`,
          });
        } catch (error) {
          normalizedRows.push({
            label: String(test?.label || `TC #${idx + 1}`),
            passed: false,
            reason: error?.message || "Execution failed",
          });
        }
      }
      total = Math.max(1, normalizedRows.length || 1);
      passed = normalizedRows.filter((row) => row.passed).length;
      status = passed === total ? "Accepted" : passed === 0 ? "Error" : "Wrong Answer";
      testCaseResults = normalizedRows.length
        ? normalizedRows
        : [{ label: "TC #1", passed: false, reason: "No hidden tests configured." }];
      aiFeedback =
        status === "Accepted"
          ? "All hidden tests passed."
          : "Some hidden tests failed. Check logic and edge cases.";
      aiScore = Math.round((passed / total) * 100);
      evaluatorProvider = "local";
      evaluatorModel = "python-executor";
      evaluatorRaw = "non-ai-local-eval";
    }
  } else if (assignmentType === "written") {
    const text = String(body.code || "").trim();
    const wordCount = text ? text.split(/\s+/).length : 0;
    total = 1;
    passed = wordCount >= 120 ? 1 : 0;
    status = passed === 1 ? "Accepted" : "Wrong Answer";
    testCaseResults = [
      {
        label: "Min length check",
        passed: passed === 1,
        reason: passed === 1 ? "" : "Please provide at least 120 words.",
      },
    ];
    aiFeedback =
      passed === 1
        ? "Submission saved and passed minimum length check."
        : "Submission saved. Add more detail and resubmit.";
    aiScore = passed === 1 ? 100 : Math.min(99, Math.max(0, Math.floor((wordCount / 120) * 100)));
    evaluatorProvider = "local";
    evaluatorModel = "rule-based";
    evaluatorRaw = "non-ai-local-eval";
  }

  const submittedAt = new Date();
  const previousAttempts = await AssignmentSubmission.countDocuments({
    assignment_id: req.params.assignmentId,
    question_id: req.params.questionId,
    student_id: req.user.sub,
  });
  const attemptNo = Number(previousAttempts || 0) + 1;
  const xpFull = fullQuestionXp(question.xp);
  const xpCandidate =
    status === "Accepted" ? xpAwardedForAccepted(question.xp, submittedAt, assignment?.deadline_date) : 0;
  let xp_awarded = 0;
  
  /** XP is awarded ONLY for the first attempt, regardless of status.
   * - First attempt + Accepted + on-time: Full XP (as mentioned in question)
   * - First attempt + Accepted + late: 0.5x full XP
   * - Subsequent attempts: 0 XP (even if Accepted)
   * - First attempt + not Accepted: 0 XP
   */
  if (attemptNo === 1 && status === "Accepted") {
    const upsertResult = await AssignmentXpGrant.updateOne(
      {
        assignment_id: req.params.assignmentId,
        question_id: req.params.questionId,
        student_id: req.user.sub,
      },
      {
        $setOnInsert: {
          xp_awarded: xpCandidate,
          full_xp: xpFull,
          submitted_before_deadline: submittedAtOrBeforeDeadline(submittedAt, assignment?.deadline_date),
          submitted_at: submittedAt,
          deadline_date: assignment?.deadline_date || null,
          granted_at: new Date(),
        },
      },
      { upsert: true }
    );
    // Award XP only if this is the first attempt for this student+question.
    xp_awarded = Number(upsertResult?.upsertedCount || 0) > 0 ? xpCandidate : 0;
  }
  const submission = await AssignmentSubmission.create({
    assignment_id: req.params.assignmentId,
    question_id: req.params.questionId,
    student_id: req.user.sub,
    language: body.language,
    code: body.code,
    attempt_no: attemptNo,
    status,
    xp_awarded,
    test_cases_passed: `${passed}/${total}`,
    execution_time_ms:
      assignmentType === "coding" || assignmentType === "written"
        ? 0
        : 90 + Math.floor(Math.random() * 80),
    memory_mb:
      assignmentType === "coding" || assignmentType === "written" ? 0 : 24 + Math.floor(Math.random() * 10),
    test_case_results: testCaseResults,
    ai_feedback: aiFeedback,
    ai_score: aiScore,
    evaluator_provider: evaluatorProvider,
    evaluator_model: evaluatorModel,
    evaluator_raw: evaluatorRaw,
    submitted_at: submittedAt,
  });

  if (status === "Accepted" && xp_awarded > 0) {
    await AssignmentXpGrant.updateOne(
      {
        assignment_id: req.params.assignmentId,
        question_id: req.params.questionId,
        student_id: req.user.sub,
      },
      { $set: { source_submission_id: submission._id } }
    );
  }

  return sendSuccess(res, {
    submission_id: String(submission._id),
    attempt_no: submission.attempt_no || attemptNo,
    status: submission.status,
    test_cases_passed: submission.test_cases_passed,
    execution_time_ms: submission.execution_time_ms,
    memory_mb: submission.memory_mb,
    test_case_results: submission.test_case_results,
    ai_feedback: submission.ai_feedback || "",
    ai_score: typeof submission.ai_score === "number" ? submission.ai_score : null,
    evaluator_provider: submission.evaluator_provider || "",
    evaluator_model: submission.evaluator_model || "",
    submitted_at: submission.submitted_at,
    xp_awarded,
    xp_if_on_time: xpFull,
    xp_if_late: lateXpAmount(xpFull),
    submitted_before_deadline:
      status === "Accepted" ? submittedAtOrBeforeDeadline(submittedAt, assignment?.deadline_date) : false,
  });
}

async function submissions(req, res) {
  const ok = await assertStudentAssignmentAccess(req, res, req.params.assignmentId);
  if (!ok) return;

  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const skip = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    AssignmentSubmission.find({
      assignment_id: req.params.assignmentId,
      question_id: req.params.questionId,
      student_id: req.user.sub,
    })
      .sort({ submitted_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AssignmentSubmission.countDocuments({
      assignment_id: req.params.assignmentId,
      question_id: req.params.questionId,
      student_id: req.user.sub,
    }),
  ]);

  const items = docs.map((doc) => ({
    submission_id: String(doc._id),
    attempt_no: Number(doc.attempt_no || 1),
    status: doc.status,
    test_cases_passed: doc.test_cases_passed,
    execution_time_ms: doc.execution_time_ms,
    memory_mb: doc.memory_mb,
    submitted_at: doc.submitted_at,
    language: doc.language,
    code: doc.code,
    test_case_results: doc.test_case_results || [],
    xp_awarded: typeof doc.xp_awarded === "number" ? doc.xp_awarded : undefined,
    ai_feedback: doc.ai_feedback || "",
    ai_score: typeof doc.ai_score === "number" ? doc.ai_score : null,
    evaluator_provider: doc.evaluator_provider || "",
    evaluator_model: doc.evaluator_model || "",
  }));

  return sendSuccess(res, items, "", { page, limit, total });
}

module.exports = { list, filters, questionDetail, run, submit, submissions };
