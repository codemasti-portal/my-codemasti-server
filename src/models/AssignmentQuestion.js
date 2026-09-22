const mongoose = require("mongoose");

const domTestSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    check_type: {
      type: String,
      required: true,
      enum: ["element_exists", "element_text", "element_attribute", "element_count", "css_rule_exists", "css_property"],
    },
    /** CSS selector used for DOM queries. */
    selector: { type: String, default: "", trim: true },
    /** Expected value for text/attribute/css checks. */
    expected_value: { type: String, default: "", trim: true },
    /** For element_attribute: which attribute to check (e.g. "class", "href"). */
    attribute_name: { type: String, default: "", trim: true },
    /** For css_property: which CSS property to check (e.g. "display", "color"). */
    property_name: { type: String, default: "", trim: true },
    /** For element_count: expected number of matching elements. */
    expected_count: { type: Number, default: 0 },
  },
  { _id: false }
);

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
    /** Optional multi-line code snippet for this option. Stored plain and rendered as a
     * verbatim <pre> on the client (no markdown fences, no language tag). */
    code: { type: String, default: "" },
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
    /** Optional video (e.g. a short clip of the expected result) shown to students. */
    question_video_url: { type: String, default: "", trim: true },
    /** Optional code snippet. Authors/LLMs supply plain code (use \\n for line breaks).
     * Quiz renders it as a verbatim <pre>. Other types may still use code_language for
     * markdown-fence highlighting at render time. */
    code: { type: String, default: "" },
    code_language: { type: String, default: "", trim: true },
    quiz_options: { type: [quizOptionSchema], default: [] },

    // ── Web (HTML/CSS) specific ──────────────────────────────────────────────
    /** Starter HTML code given to the student (pre-filled in editor). */
    html_starter: { type: String, default: "" },
    /** Starter CSS code given to the student (pre-filled in editor). */
    css_starter: { type: String, default: "" },
    /** Auto-grading checks. Only labels are sent to students — selectors/check_type are server-only. */
    dom_tests: { type: [domTestSchema], default: [] },
    /** Author-only reference solution (a correct answer) used to verify dom_tests at authoring time. NEVER sent to students. */
    solution_html: { type: String, default: "" },
    solution_css: { type: String, default: "" },

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

    // ── Project-specific instructional document (not separate questions) ─────
    project_document: {
      type: {
        overview: { type: String, default: "" },
        prerequisites: { type: String, default: "" },
        steps: {
          type: [
            {
              step_id: { type: String, required: true, trim: true },
              title: { type: String, default: "", trim: true },
              content: { type: String, default: "" },
              images: {
                type: [{ url: { type: String, trim: true }, label: { type: String, default: "", trim: true }, _id: false }],
                default: [],
              },
              videos: {
                type: [{ url: { type: String, trim: true }, label: { type: String, default: "", trim: true }, _id: false }],
                default: [],
              },
              resources: {
                type: [{ url: { type: String, trim: true }, label: { type: String, default: "", trim: true }, _id: false }],
                default: [],
              },
              _id: false,
            },
          ],
          default: [],
        },
        deliverables: { type: String, default: "" },
      },
      default: () => ({ overview: "", prerequisites: "", steps: [], deliverables: "" }),
    },
    /**
     * Project-only discriminator. "canonical" marks the single document question for a
     * newly authored Project. Empty on quiz/coding/written/web and on historical Project
     * questions so a partial unique index can enforce at-most-one canonical row without
     * breaking multi-question assignment types or legacy multi-question Projects.
     */
    project_slot: { type: String, default: "", trim: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

/**
 * At most one canonical Project question per assignment.
 * Historical Project questions omit project_slot (or leave it "") and are not constrained.
 */
assignmentQuestionSchema.index(
  { assignment_id: 1 },
  {
    unique: true,
    name: "uniq_project_canonical_question",
    partialFilterExpression: { project_slot: "canonical" },
  }
);

module.exports = mongoose.model("AssignmentQuestion", assignmentQuestionSchema);
