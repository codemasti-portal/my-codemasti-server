const mongoose = require("mongoose");

const ICON_KEYS = ["trophy", "flame", "swords", "medal", "star", "zap"];
const ACCENTS = ["amber", "sky", "orange", "emerald", "violet", "rose"];

const AWARD_RULE_KINDS = [
  "arena_distinct_solved",
  "arena_best_streak_ist",
  "assignment_monthly_ist_xp",
  "student_total_xp_milestone",
];

/**
 * Admin-authored achievement badge: draft/publish and rule that defines who earns it.
 * Published programs are evaluated for every student where applicable (Arena activity, achievements load, scans).
 */
const badgeProgramSchema = new mongoose.Schema(
  {
    /** Immutable slug used on StudentAchievementBadge rows */
    badge_code: { type: String, required: true, unique: true, trim: true, lowercase: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    icon_key: { type: String, enum: ICON_KEYS, default: "trophy" },
    accent: { type: String, enum: ACCENTS, default: "amber" },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    published_at: { type: Date, default: null },
    award_rule_kind: {
      type: String,
      enum: AWARD_RULE_KINDS,
      required: true,
    },
    /** Meaning depends on kind: quests, streak days, monthly XP cutoff, lifetime XP cutoff */
    award_rule_threshold: { type: Number, required: true, min: 1 },
    /**
     * When to treat an IST calendar month ("YYYY-MM") as evaluable for `assignment_monthly_ist_xp`.
     * - ist_auto — as soon as the month has ended (IST).
     * - ist_custom_dom — after the chosen IST calendar day-of-month (1–31) in the FOLLOWING month.
     */
    monthly_evaluation: {
      type: String,
      enum: ["ist_auto", "ist_custom_dom"],
      default: "ist_auto",
    },
    monthly_custom_dom: { type: Number, min: 1, max: 31, default: null },
    /** Background image (e.g. Cloudinary URL) for custom badge art */
    custom_image_url: { type: String, default: "", trim: true },
    /** Draggable text overlay spec: { w, h, layers: [...] } */
    badge_layout: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true, versionKey: false }
);

badgeProgramSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("BadgeProgram", badgeProgramSchema);
module.exports.ICON_KEYS = ICON_KEYS;
module.exports.ACCENTS = ACCENTS;
module.exports.AWARD_RULE_KINDS = AWARD_RULE_KINDS;
