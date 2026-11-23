const AchievementBadgeDefinition = require("../models/AchievementBadgeDefinition");
const { ARENA_QUEST_MILESTONES, ARENA_STREAK_BEST_MILESTONES } = require("../config/achievement-badges");

const MONTHLY_BADGE_CODE = "student_of_the_month";

const DEFAULT_MONTHLY_PRESENTATION = {
  badge_code: MONTHLY_BADGE_CODE,
  category: "monthly_leaderboard",
  title: "Student of the Month",
  description:
    "Highest XP in your batch for a full India Standard Time (IST) calendar month. Finalized automatically after the month closes.",
  icon_key: "trophy",
  accent: "amber",
};

function allowedBadgeCodesSpec() {
  const out = new Map();
  out.set(MONTHLY_BADGE_CODE, {
    category: "monthly_leaderboard",
    sort_order: 0,
    ...DEFAULT_MONTHLY_PRESENTATION,
  });
  for (const d of ARENA_QUEST_MILESTONES) {
    out.set(d.code, {
      category: "arena_quests",
      sort_order: d.at,
      title: d.title,
      description: d.description,
      icon_key: "swords",
      accent: "sky",
    });
  }
  for (const d of ARENA_STREAK_BEST_MILESTONES) {
    out.set(d.code, {
      category: "arena_streak",
      sort_order: d.days,
      title: d.title,
      description: d.description,
      icon_key: "flame",
      accent: "orange",
    });
  }
  return out;
}

/**
 * Published row wins; otherwise built-in default for that programmable badge.
 */
async function getPublishedPresentation(badgeCode) {
  const code = String(badgeCode || "").trim().toLowerCase();
  const spec = allowedBadgeCodesSpec().get(code);
  if (!spec) return null;

  const row = await AchievementBadgeDefinition.findOne({ badge_code: code, is_published: true }).lean();
  if (!row) {
    return {
      badge_code: code,
      category: spec.category,
      title: spec.title,
      description: spec.description || "",
      icon_key: spec.icon_key,
      accent: spec.accent,
      source: "system_default",
    };
  }

  return {
    badge_code: code,
    category: row.category,
    title: row.title || spec.title,
    description: row.description != null ? row.description : spec.description || "",
    icon_key: row.icon_key || spec.icon_key,
    accent: row.accent || spec.accent,
    source: "published",
  };
}

module.exports = {
  MONTHLY_BADGE_CODE,
  DEFAULT_MONTHLY_PRESENTATION,
  allowedBadgeCodesSpec,
  getPublishedPresentation,
};
