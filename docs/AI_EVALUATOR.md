# AI evaluator

File: `src/services/deepseek-evaluator.js` (the name is historical; it also drives Gemini). Called only from `src/controllers/assignment.controller.js` (submission endpoint).

## What is graded by what

| Assignment type | Grader | LLM involved? |
|---|---|---|
| `quiz` | Compares the selected option with `quiz_options[].is_correct` | no |
| coding (`python`, `javascript`) | Runs the student's code against up to 20 hidden tests: `js-executor.js` / `python-wasm-executor.js`. Result is stamped `evaluator_provider: "local"`, `evaluator_raw: "non-ai-local-eval"` | **no** |
| `web` (HTML/CSS) | `web-evaluator.js` runs `dom_tests` with cheerio / css-tree | no |
| `written` | `evaluateWrittenAnswer()` | **yes** |
| `project` | Evidence submission, separate flow | not via this file |

The module exports only `evaluateWrittenAnswer`, `fallbackWrittenEvaluation` and `checkInjection`. The former LLM coding grader (`evaluateWithDeepseek`) and its `fallbackEvaluation` were removed because nothing called them.

## Provider selection

`callLLM()`:
1. If `GEMINI_API_KEY` is set -> Gemini (`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, `responseMimeType: application/json`, temperature 0.1).
2. Else if `DEEPSEEK_API_KEY` is set -> DeepSeek (`https://api.deepseek.com/chat/completions`, temperature 0.1).
3. Else throws `No LLM provider configured`.

Gemini wins when both are set; there is **no cross-provider failover** — the other provider is used only if the preferred key is absent. Transient errors (HTTP 429, 500, 502, 503) are retried twice (2 s, then 5 s) with the same provider.

| Variable | Default |
|---|---|
| `GEMINI_API_KEY` | none |
| `GEMINI_MODEL` | `gemini-3.5-flash` |
| `DEEPSEEK_API_KEY` | none |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` |

## Written evaluation flow (`submit` -> `evaluateWrittenAnswer`)

1. Controller: if the answer has fewer than `question.min_word_count` words (default 80) it is rejected locally (`provider: local`, score capped at 59) with no LLM call.
2. **Layer 1, local input guard** (`checkInjection`): ~20 regexes for role-change/override phrases, score-manipulation requests, delimiter/system tags, exfiltration requests and long base64-like blobs. A hit short-circuits with a zero-score "flagged" result and no API call.
3. Answer is truncated to `max_word_count` (min 100, default 1000) words.
4. **Layer 2, sandboxed prompt**: the system prompt declares `<STUDENT_ANSWER>` content untrusted and the evaluator role fixed; question/rubric/reference answer are in trusted sections; the model must write a rationale (topic analysis, per-dimension scoring) before scores and return strict JSON with `dimensions[]`, `total_score`, `feedback`, `covered_topics`, `missing_topics`, `flagged_injection`.
5. **Layer 3, output guard**: the raw model output is scanned for phrases showing the model obeyed the student (`MANIPULATION_PHRASES`), and `parsed.flagged_injection === true` is honoured. Either yields the flagged result. Dimension scores are clamped to each rubric dimension's `max_score`; the total is **recomputed locally** from the weighted rubric (the model's `total_score` is ignored). An anomaly check flags answers shorter than `max(15, min_word_count/2)` words that score above 60%.
6. Status is `Accepted` if the computed score is at least 60, else `Wrong Answer`.
7. **Layer 4, DB flag**: the controller writes `flagged_injection` (boolean) together with `rubric_results`, `ai_feedback`, `ai_score`, `evaluator_provider`, `evaluator_model`, `evaluator_raw` on the `AssignmentSubmission`.
8. On any LLM error the controller logs `[written-eval] LLM error` and stores `fallbackWrittenEvaluation()` (score 0, `provider: "fallback"`, `model: "rule-based"`, message that grading will be retried; **nothing re-grades it automatically**).

Default rubric (when the question has none): Correctness (weight 2, max 5), Completeness (2, 5), Clarity (1, 5).

## Where results live

Collection `AssignmentSubmission` (`src/models/AssignmentSubmission.js`): `status`, `ai_score`, `ai_feedback`, `rubric_results[]`, `test_case_results[]`, `evaluator_provider`, `evaluator_model`, `evaluator_raw`, `flagged_injection`.

## Gaps worth a decision

- `flagged_injection` is written, but no API or UI in the server, admin or portal code reads it, so the "admin review" the layer-4 comment refers to has no consumer.
- A flagged result is recorded with `provider: "deepseek"`, `model: "local-guard"` even when Gemini is the active provider (`buildInjectionResult`).
- Fallback results are not retried.
