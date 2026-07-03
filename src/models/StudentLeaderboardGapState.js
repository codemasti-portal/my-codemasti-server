const mongoose = require("mongoose");

/**
 * Per-student snapshot of "who was directly above me" on the batch leaderboard the last time we
 * checked (all-time, batch-scoped). Compared on every check to detect a genuine overtake — the
 * previously-above student is no longer above, and this student's rank improved. Powers the
 * "Closed the Gap" badge without needing to store full leaderboard history.
 */
const schema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, unique: true, index: true },
    batch_id: { type: String, default: "", trim: true, lowercase: true },
    last_above_student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
    last_rank: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("StudentLeaderboardGapState", schema);
