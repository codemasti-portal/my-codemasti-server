const mongoose = require("mongoose");

const starterCodeSchema = new mongoose.Schema(
  {
    python: { type: String, default: "" },
    javascript: { type: String, default: "" },
  },
  { _id: false }
);

const quizOptionSchema = new mongoose.Schema(
  {
    text: { type: String, default: "", trim: true },
    image_url: { type: String, default: "", trim: true },
    is_correct: { type: Boolean, default: false },
  },
  { _id: false }
);

const assignmentQuestionSchema = new mongoose.Schema(
  {
    assignment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "easy", index: true },
    xp: { type: Number, default: 10 },
    topics: [{ type: String, trim: true, index: true }],
    requirements: [{ type: String }],
    input_format: { type: String, default: "" },
    output_format: { type: String, default: "" },
    constraints: [{ type: String }],
    examples: [{ type: mongoose.Schema.Types.Mixed }],
    time_limit: { type: String, default: "1s" },
    memory_limit: { type: String, default: "128MB" },
    execution_mode: { type: String, enum: ["full_program", "function_only"], default: "full_program" },
    starter_code: { type: starterCodeSchema, default: () => ({}) },
    hidden_tests: [{ type: mongoose.Schema.Types.Mixed }],
    question_image_url: { type: String, default: "", trim: true },
    /** Optional code snippet rendered as a highlighted block. We add the ``` fences at render time —
     * LLMs are unreliable at producing backticks inside JSON, so authors/LLMs supply plain code + language. */
    code: { type: String, default: "" },
    code_language: { type: String, default: "", trim: true },
    quiz_options: { type: [quizOptionSchema], default: [] },

    // ── Written-answer specific ──────────────────────────────────────────────
    /** Minimum word count accepted before sending to AI evaluator. */
    min_word_count: { type: Number, default: 80 },
    /** Hard cap on answer length (words). Excess is truncated before evaluation. */
    max_word_count: { type: Number, default: 1000 },
    /** Reference answer for the AI evaluator. NEVER sent to students. */
    ideal_answer: { type: String, default: "" },
    /** Key topics/concepts expected in a full-credit answer. */
    expected_topics: [{ type: String, trim: true }],
    /**
     * Analytic scoring rubric — one entry per dimension.
     * Each dimension contributes (score / max_score * weight) to the total.
     */
    scoring_rubric: {
      type: [
        {
          dimension:   { type: String, trim: true, default: "" },
          weight:      { type: Number, default: 1 },
          max_score:   { type: Number, default: 5 },
          description: { type: String, default: "" },
          _id:         false,
        },
      ],
      default: () => [
        { dimension: "Correctness",  weight: 2, max_score: 5, description: "Are the facts and concepts accurate?" },
        { dimension: "Completeness", weight: 2, max_score: 5, description: "Are all expected topics covered?" },
        { dimension: "Clarity",      weight: 1, max_score: 5, description: "Is the answer well-structured and easy to understand?" },
      ],
    },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("AssignmentQuestion", assignmentQuestionSchema);
