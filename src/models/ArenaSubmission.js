const mongoose = require("mongoose");

const arenaSubmissionSchema = new mongoose.Schema(
  {
    question_id: { type: mongoose.Schema.Types.ObjectId, ref: "ArenaQuestion", required: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    language: { type: String, required: true },
    code: { type: String, required: true },
    status: { type: String, default: "Accepted" },
    test_cases_passed: { type: String, default: "" },
    execution_time_ms: { type: Number, default: 0 },
    memory_mb: { type: Number, default: 0 },
    submitted_at: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

arenaSubmissionSchema.index({ question_id: 1, student_id: 1, submitted_at: -1 });

module.exports = mongoose.model("ArenaSubmission", arenaSubmissionSchema);
