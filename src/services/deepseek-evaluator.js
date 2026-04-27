const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-coder";

function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const direct = safeJsonParse(trimmed);
  if (direct && typeof direct === "object") return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return safeJsonParse(trimmed.slice(start, end + 1));
}

function normalizeResult(raw, fallbackTotal) {
  const verdictRaw = String(raw?.verdict || "").trim().toLowerCase();
  const verdict = verdictRaw === "accepted" ? "Accepted" : verdictRaw === "wrong answer" ? "Wrong Answer" : "Error";

  const rows = Array.isArray(raw?.test_case_results) ? raw.test_case_results : [];
  const test_case_results = rows.map((r, idx) => ({
    label: String(r?.label || `TC #${idx + 1}`),
    passed: Boolean(r?.passed),
    reason: String(r?.reason || ""),
  }));
  const total = Math.max(1, Number(fallbackTotal) || test_case_results.length || 1);
  const passedCount = test_case_results.filter((x) => x.passed).length;

  return {
    status: verdict,
    test_cases_passed: `${passedCount}/${Math.max(total, test_case_results.length || total)}`,
    test_case_results,
    feedback: String(raw?.feedback || "").trim(),
    score: Number.isFinite(Number(raw?.score)) ? Math.max(0, Math.min(100, Number(raw.score))) : undefined,
    execution_time_ms: Number.isFinite(Number(raw?.execution_time_ms))
      ? Math.max(0, Math.floor(Number(raw.execution_time_ms)))
      : 0,
    memory_mb: Number.isFinite(Number(raw?.memory_mb)) ? Math.max(0, Math.floor(Number(raw.memory_mb))) : 0,
  };
}

function buildPayload({ assignmentType, question, submission }) {
  return {
    assignment_type: assignmentType,
    question: {
      title: question?.title || "",
      description: question?.description || "",
      requirements: Array.isArray(question?.requirements) ? question.requirements : [],
      input_format: question?.input_format || "",
      output_format: question?.output_format || "",
      constraints: Array.isArray(question?.constraints) ? question.constraints : [],
      examples: Array.isArray(question?.examples) ? question.examples : [],
      hidden_tests: Array.isArray(question?.hidden_tests) ? question.hidden_tests : [],
    },
    submission: {
      language: submission?.language || "",
      code: submission?.code || "",
    },
  };
}

async function evaluateWithDeepseek(input) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DeepSeek not configured: set DEEPSEEK_API_KEY");
  }

  const payload = buildPayload(input);
  const prompt = `
Evaluate this student submission strictly.

Return ONLY valid JSON with this exact shape:
{
  "verdict": "Accepted" | "Wrong Answer" | "Error",
  "score": number,
  "feedback": "short evaluator feedback",
  "test_case_results": [
    { "label": "TC #1", "passed": true, "reason": "optional short reason" }
  ],
  "execution_time_ms": number,
  "memory_mb": number
}

Rules:
- Use hidden_tests and requirements for correctness.
- For written answers, evaluate conceptual correctness and completeness.
- Keep feedback concise and actionable.
- Do not include markdown. JSON only.

Data:
${JSON.stringify(payload)}
  `.trim();

  const res = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a strict coding and written-answer evaluator.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`DeepSeek request failed: ${res.status} ${res.statusText} ${bodyText}`.trim());
    err.statusCode = res.status;
    err.provider = "deepseek";
    err.raw = bodyText;
    throw err;
  }

  const json = await res.json();
  const content = String(json?.choices?.[0]?.message?.content || "");
  const parsed = extractFirstJsonObject(content);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("DeepSeek response parsing failed: evaluator did not return valid JSON.");
  }

  return {
    ...normalizeResult(parsed, Array.isArray(input?.question?.hidden_tests) ? input.question.hidden_tests.length : 1),
    provider: "deepseek",
    model: DEFAULT_MODEL,
    raw: content,
  };
}

function fallbackEvaluation({ assignmentType, question }) {
  const hiddenTests = Array.isArray(question?.hidden_tests) ? question.hidden_tests : [];
  const total = Math.max(1, hiddenTests.length || 1);
  return {
    status: "Wrong Answer",
    test_cases_passed: `0/${total}`,
    test_case_results: Array.from({ length: total }, (_, idx) => ({
      label: `TC #${idx + 1}`,
      passed: false,
      reason: "AI evaluator unavailable",
    })),
    feedback:
      assignmentType === "written"
        ? "Evaluation service is temporarily unavailable due to provider balance. Your answer is saved; please retry later."
        : "Evaluation service is temporarily unavailable due to provider balance. Your code is saved; please retry later.",
    score: 0,
    execution_time_ms: 0,
    memory_mb: 0,
    provider: "fallback",
    model: "local-fallback",
    raw: "DeepSeek unavailable (insufficient balance or provider error).",
  };
}

module.exports = { evaluateWithDeepseek, fallbackEvaluation };
