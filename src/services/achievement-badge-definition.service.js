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

function isAllowedBadgeCode(code) {
  return allowedBadgeCodesSpec().has(String(code || "").trim().toLowerCase());
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

/**
 * Admin catalog: every wired badge_code with DB draft/publish state merged with defaults.
 */
async function listCatalogForAdmin() {
  const spec = allowedBadgeCodesSpec();
  const codes = [...spec.keys()].sort((a, b) => {
    const sa = spec.get(a);
    const sb = spec.get(b);
    if (sa.category !== sb.category) return sa.category.localeCompare(sb.category);
    return (sa.sort_order || 0) - (sb.sort_order || 0) || a.localeCompare(b);
  });

  const rows = await AchievementBadgeDefinition.find({ badge_code: { $in: codes } }).lean();
  const byCode = new Map(rows.map((r) => [r.badge_code, r]));

  return codes.map((badge_code) => {
    const s = spec.get(badge_code);
    const row = byCode.get(badge_code);
    return {
      badge_code,
      category: s.category,
      system_default: {
        title: s.title,
        description: s.description || "",
        icon_key: s.icon_key,
        accent: s.accent,
      },
      draft: row
        ? {
            title: row.title,
            description: row.description || "",
            icon_key: row.icon_key,
            accent: row.accent,
            is_published: Boolean(row.is_published),
            updated_at: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
          }
        : null,
      effective: row?.is_published
        ? {
            title: row.title,
            description: row.description || "",
            icon_key: row.icon_key,
            accent: row.accent,
            is_published: true,
          }
        : {
            title: s.title,
            description: s.description || "",
            icon_key: s.icon_key,
            accent: s.accent,
            is_published: false,
          },
    };
  });
}

async function upsertDefinition(badgeCode, payload = {}) {
  const code = String(badgeCode || "").trim().toLowerCase();
  if (!isAllowedBadgeCode(code)) {
    const err = new Error("BADGE_CODE_NOT_PROGRAMMABLE");
    err.code = "BADGE_CODE_NOT_PROGRAMMABLE";
    throw err;
  }
  const spec = allowedBadgeCodesSpec().get(code);
  const allowedIcons = AchievementBadgeDefinition.ICON_KEYS;
  const allowedAccents = AchievementBadgeDefinition.ACCENTS;

  const existing = await AchievementBadgeDefinition.findOne({ badge_code: code }).lean();

  const merged = {
    title: existing?.title ?? spec.title,
    description: existing?.description ?? spec.description ?? "",
    icon_key: existing?.icon_key ?? spec.icon_key,
    accent: existing?.accent ?? spec.accent,
    is_published: Boolean(existing?.is_published),
  };

  if (payload.title != null) merged.title = String(payload.title).trim().slice(0, 120);
  if (payload.description != null) merged.description = String(payload.description).trim().slice(0, 500);
  if (payload.icon_key != null) {
    const ik = String(payload.icon_key).trim();
    if (!allowedIcons.includes(ik)) {
      const err = new Error("INVALID_ICON_KEY");
      err.code = "INVALID_ICON_KEY";
      throw err;
    }
    merged.icon_key = ik;
  }
  if (payload.accent != null) {
    const ac = String(payload.accent).trim();
    if (!allowedAccents.includes(ac)) {
      const err = new Error("INVALID_ACCENT");
      err.code = "INVALID_ACCENT";
      throw err;
    }
    merged.accent = ac;
  }
  if (payload.is_published != null) merged.is_published = Boolean(payload.is_published);

  const touched =
    payload.title != null ||
    payload.description != null ||
    payload.icon_key != null ||
    payload.accent != null ||
    payload.is_published != null;

  if (!touched) {
    const err = new Error("EMPTY_PATCH");
    err.code = "EMPTY_PATCH";
    throw err;
  }

  const doc = await AchievementBadgeDefinition.findOneAndUpdate(
    { badge_code: code },
    {
      $set: {
        badge_code: code,
        category: spec.category,
        sort_order: spec.sort_order ?? 0,
        title: merged.title,
        description: merged.description,
        icon_key: merged.icon_key,
        accent: merged.accent,
        is_published: merged.is_published,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return doc;
}

module.exports = {
  MONTHLY_BADGE_CODE,
  DEFAULT_MONTHLY_PRESENTATION,
  allowedBadgeCodesSpec,
  isAllowedBadgeCode,
  getPublishedPresentation,
  listCatalogForAdmin,
  upsertDefinition,
};
