const mongoose = require("mongoose");

const assignmentSubmissionSchema = new mongoose.Schema(
  {
    assignment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
      index: true,
    },
    question_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AssignmentQuestion",
      required: true,
      index: true,
    },
    student_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    language: { type: String, default: "", trim: true },
    code: { type: String, default: "" },
    attempt_no: { type: Number, default: 1, index: true },
    status: { type: String, default: "Accepted", index: true },
    /** Empty for existing quiz/coding/written/web rows. "project" for Project evidence submissions. */
    kind: { type: String, default: "", trim: true, index: true },
    /** XP granted for this submission when status is Accepted (full if on/before assignment deadline, else half). */
    xp_awarded: { type: Number, default: 0 },
    /**
     * Project evidence + instructor review. Technical Accepted status still drives XP aggregation.
     * review_status is independent of status (submission accepted ≠ instructor evaluation).
     */
    project: {
      type: {
        explanation_video_url: { type: String, default: "" },
        demo_video_url: { type: String, default: "" },
        github_repository_url: { type: String, default: "" },
        review_status: { type: String, enum: ["pending", "evaluated"], default: "pending" },
        marks: { type: Number, default: null },
        feedback: { type: String, default: "" },
        reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
        evaluated_at: { type: Date, default: null },
      },
      default: undefined,
    },
    test_cases_passed: { type: String, default: "0/0" },
    execution_time_ms: { type: Number, default: 0 },
    memory_mb: { type: Number, default: 0 },
    test_case_results: [{ type: mongoose.Schema.Types.Mixed }],
    stdout: { type: String, default: "" },
    stderr: { type: String, default: "" },
    ai_feedback: { type: String, default: "" },
    ai_score: { type: Number, default: null },
    /** Per-dimension rubric results for written assignments (label=dimension name, score/max in reason). */
    rubric_results: [{ type: mongoose.Schema.Types.Mixed }],
    evaluator_provider: { type: String, default: "" },
    evaluator_model: { type: String, default: "" },
    evaluator_raw: { type: String, default: "" },
    /** True when the submission's text triggered the injection guard. Score is forced to 0. */
    flagged_injection: { type: Boolean, default: false },
    submitted_at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false }
);

assignmentSubmissionSchema.index(
  { assignment_id: 1, student_id: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "project" },
    name: "uniq_project_assignment_student",
  }
);

module.exports = mongoose.model("AssignmentSubmission", assignmentSubmissionSchema);
