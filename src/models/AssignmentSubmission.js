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
    language: { type: String, required: true, trim: true },
    code: { type: String, required: true },
    attempt_no: { type: Number, default: 1, index: true },
    status: { type: String, default: "Accepted", index: true },
    /** XP granted for this submission when status is Accepted (full if on/before assignment deadline, else half). */
    xp_awarded: { type: Number, default: 0 },
    test_cases_passed: { type: String, default: "0/0" },
    execution_time_ms: { type: Number, default: 0 },
    memory_mb: { type: Number, default: 0 },
    test_case_results: [{ type: mongoose.Schema.Types.Mixed }],
    stdout: { type: String, default: "" },
    stderr: { type: String, default: "" },
    ai_feedback: { type: String, default: "" },
    ai_score: { type: Number, default: null },
    evaluator_provider: { type: String, default: "" },
    evaluator_model: { type: String, default: "" },
    evaluator_raw: { type: String, default: "" },
    submitted_at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("AssignmentSubmission", assignmentSubmissionSchema);
