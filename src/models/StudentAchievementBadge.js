const mongoose = require("mongoose");

/**
 * Persisted milestones (Arena quest counts & streak tiers). Separate from MonthlyLeaderboardBadge.
 */
const studentAchievementBadgeSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    badge_code: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["arena_quests", "arena_streak", "program"],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    /** Quest/streak/program threshold encoded meaning depends on category */
    threshold_value: { type: Number, required: true, min: 0 },
    icon_key: { type: String, default: "trophy", trim: true },
    accent: { type: String, default: "sky", trim: true },
    custom_image_url: { type: String, default: "", trim: true },
    badge_layout: { type: mongoose.Schema.Types.Mixed, default: undefined },
    awarded_at: { type: Date, default: Date.now },
    /**
     * IST month key "YYYY-MM" for recurring program badges (e.g. monthly XP). Empty string for one-off rules.
     * Compound unique with student_id + badge_code allows multiple monthly awards per learner per program.
     */
    award_period: { type: String, default: "", trim: true },
  },
  { timestamps: false, versionKey: false }
);

studentAchievementBadgeSchema.index({ student_id: 1, badge_code: 1, award_period: 1 }, { unique: true });

module.exports = mongoose.model("StudentAchievementBadge", studentAchievementBadgeSchema);
