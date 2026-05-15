const mongoose = require("mongoose");

/**
 * One row per (cohort / scope, calendar month): top XP earner in that peer group for that IST month (Asia/Kolkata).
 * Finalized after the India calendar month ends (lazy finalization on read or cron).
 */
const monthlyLeaderboardBadgeSchema = new mongoose.Schema(
  {
    /** "2026-05" labels the India Standard Time calendar month */
    period: { type: String, required: true, trim: true, index: true },
    /** Normalized batch_id, or "solo:&lt;studentId&gt;" when batch_id is empty */
    scope_key: { type: String, required: true, trim: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true },
    xp: { type: Number, required: true, min: 0 },
    badge_code: {
      type: String,
      default: "student_of_the_month",
      trim: true,
    },
    title: { type: String, default: "Student of the Month", trim: true },
    description: { type: String, default: "", trim: true },
    icon_key: { type: String, default: "trophy", trim: true },
    accent: { type: String, default: "amber", trim: true },
    /** Snapshot when the badge was finalized (helps hall-of-fame if profile changes later) */
    student_name_snapshot: { type: String, default: "", trim: true },
    avatar_url_snapshot: { type: String, default: "", trim: true },
    finalized_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

monthlyLeaderboardBadgeSchema.index({ period: 1, scope_key: 1 }, { unique: true });
monthlyLeaderboardBadgeSchema.index({ student_id: 1, period: -1 });

module.exports = mongoose.model("MonthlyLeaderboardBadge", monthlyLeaderboardBadgeSchema);
