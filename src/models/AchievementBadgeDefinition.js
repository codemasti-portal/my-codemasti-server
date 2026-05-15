const mongoose = require("mongoose");

const ICON_KEYS = ["trophy", "flame", "swords", "medal", "star", "zap"];
const ACCENTS = ["amber", "sky", "orange", "emerald", "violet", "rose"];

const achievementBadgeDefinitionSchema = new mongoose.Schema(
  {
    /** Stable key wired to awarding logic e.g. student_of_the_month, arena_quests_50 */
    badge_code: { type: String, required: true, unique: true, trim: true, lowercase: true },
    category: {
      type: String,
      enum: ["monthly_leaderboard", "arena_quests", "arena_streak"],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    icon_key: { type: String, enum: ICON_KEYS, default: "trophy" },
    accent: { type: String, enum: ACCENTS, default: "amber" },
    /** When false, automation and student UI fall back to built-in defaults for this badge_code. */
    is_published: { type: Boolean, default: false },
    sort_order: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

achievementBadgeDefinitionSchema.index({ category: 1, sort_order: 1, badge_code: 1 });

module.exports = mongoose.model("AchievementBadgeDefinition", achievementBadgeDefinitionSchema);
module.exports.ICON_KEYS = ICON_KEYS;
module.exports.ACCENTS = ACCENTS;
