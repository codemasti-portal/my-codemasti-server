const crypto = require("crypto");
const mongoose = require("mongoose");
const BadgeProgram = require("../models/BadgeProgram");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");
const Student = require("../models/Student");
const {
  batchArenaQuestionIdsForStudent,
  countDistinctArenaQuestsSolved,
  bestArenaAcceptedStreakDaysIst,
} = require("./student-achievement.service");
const {
  submittedAtIndiaCalendarMonth,
  indianPeriodFirstInstantAfterClosed,
  recentClosedIndianMonthPeriods,
} = require("../utils/india-time");
const { buildRowsForSubmittedFilter } = require("../controllers/leaderboard.controller");

const AWARD_KINDS = new Set([
  "arena_distinct_solved",
  "arena_best_streak_ist",
  "assignment_monthly_ist_xp",
  "student_total_xp_milestone",
]);

const BIND_VALUES = ["none", "student_name", "program_title", "awarded_date"];

function normalizeBadgeLayout(raw) {
  const base = { w: 320, h: 320, layers: [] };
  if (!raw || typeof raw !== "object") return base;
  const w = Math.min(800, Math.max(120, Math.floor(Number(raw.w) || 320)));
  const h = Math.min(800, Math.max(120, Math.floor(Number(raw.h) || 320)));
  const arr = Array.isArray(raw.layers) ? raw.layers : [];
  const layers = arr.slice(0, 24).map((layer, idx) => {
    const bind = BIND_VALUES.includes(String(layer?.bind)) ? String(layer.bind) : "none";
    let xPct = Number(layer?.xPct);
    let yPct = Number(layer?.yPct);
    if (!Number.isFinite(xPct) && Number.isFinite(Number(layer?.x))) xPct = (Number(layer.x) / w) * 100;
    if (!Number.isFinite(yPct) && Number.isFinite(Number(layer?.y))) yPct = (Number(layer.y) / h) * 100;
    const xPctN = Math.min(100, Math.max(0, Number.isFinite(xPct) ? xPct : 50));
    const yPctN = Math.min(100, Math.max(0, Number.isFinite(yPct) ? yPct : 50));
    let widthPct = Number(layer?.widthPct);
    if (!Number.isFinite(widthPct)) {
      const wx = Number(layer?.width);
      widthPct = Number.isFinite(wx) ? Math.min(100, Math.max(8, (wx / w) * 100)) : 88;
    }
    const widthPctN = Math.min(100, Math.max(8, widthPct));
    const fontSize = Math.min(64, Math.max(8, Math.floor(Number(layer?.fontSize) || 16)));
    const text = String(layer?.text ?? "").trim().slice(0, 280);
    const fill = String(layer?.fill ?? "#ffffff").trim().slice(0, 32) || "#ffffff";
    const fontWeight = layer?.fontWeight === "bold" ? "bold" : "normal";
    const align = ["left", "center", "right"].includes(String(layer?.align)) ? String(layer.align) : "center";
    return {
      id: String(layer?.id || `layer-${idx}`),
      type: "text",
      xPct: xPctN,
      yPct: yPctN,
      widthPct: widthPctN,
      text,
      fontSize,
      fill,
      fontWeight,
      align,
      bind,
    };
  });
  return { w, h, layers };
}

function slugFragment(title) {
  return (
    String(title || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "badge"
  );
}

async function generateUniqueBadgeCode(title) {
  for (let i = 0; i < 8; i += 1) {
    const suffix = crypto.randomBytes(3).toString("hex");
    const code = `${slugFragment(title)}-${suffix}`;
    const exists = await BadgeProgram.exists({ badge_code: code });
    if (!exists) return code;
  }
  return `${slugFragment(title)}-${crypto.randomBytes(6).toString("hex")}`;
}

function pad2(n) {
  return String(Math.floor(Number(n))).padStart(2, "0");
}

function parsePeriodYm(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return null;
  return { y, mo };
}

/** First UTC instant learners may receive awards for IST period `YYYY-MM` (exclusive end of winning month resolved). */
function monthlyEvaluationOpensAtUtc(programLean, period) {
  const baseClose = indianPeriodFirstInstantAfterClosed(period);
  if (!baseClose) return null;
  const mode = String(programLean.monthly_evaluation || "ist_auto").trim();
  if (mode !== "ist_custom_dom" || programLean.monthly_custom_dom == null || programLean.monthly_custom_dom === "") {
    return baseClose;
  }
  const p = parsePeriodYm(period);
  if (!p) return baseClose;

  let { y, mo } = p;
  mo += 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  const dom = Math.min(31, Math.max(1, Math.floor(Number(programLean.monthly_custom_dom))));
  try {
    return new Date(`${y}-${pad2(mo)}-${pad2(dom)}T00:00:00+05:30`);
  } catch {
    return baseClose;
  }
}

function monthlyPeriodEvaluable(programLean, period, nowDate = new Date()) {
  const open = monthlyEvaluationOpensAtUtc(programLean, period);
  return !!(open && nowDate >= open);
}

function qualifiesArena(programLean, questsSolved, bestStreak) {
  const kind = String(programLean.award_rule_kind || "");
  const threshold = Math.max(1, Math.floor(Number(programLean.award_rule_threshold || 1)));
  if (kind === "arena_distinct_solved") return questsSolved >= threshold;
  if (kind === "arena_best_streak_ist") return bestStreak >= threshold;
  return false;
}

function coerceThreshold(kind, raw) {
  const k = String(kind || "").trim();
  const tNum = Number(raw);
  if (k === "arena_distinct_solved" || k === "arena_best_streak_ist") {
    if (!Number.isFinite(tNum)) {
      throw Object.assign(new Error("INVALID_THRESHOLD"), { code: "INVALID_THRESHOLD" });
    }
    return Math.max(1, Math.floor(tNum));
  }
  if (!Number.isFinite(tNum)) {
    throw Object.assign(new Error("INVALID_THRESHOLD"), { code: "INVALID_THRESHOLD" });
  }
  if (k === "student_total_xp_milestone") {
    const threshold = Math.floor(tNum);
    if (threshold < 500) {
      throw Object.assign(new Error("INVALID_THRESHOLD"), { code: "INVALID_THRESHOLD" });
    }
    return threshold;
  }
  const threshold = Math.max(1, Math.floor(tNum));
  return threshold;
}

async function grantArenaOrLifetimeProgramBadge(studentId, programLean, opts = {}) {
  const sid = String(studentId);
  if (!mongoose.Types.ObjectId.isValid(sid)) return false;
  const oid = new mongoose.Types.ObjectId(sid);
  const code = String(programLean.badge_code || "").trim().toLowerCase();
  const kind = String(programLean.award_rule_kind || "");
  if (!code) return false;
  if (kind === "assignment_monthly_ist_xp") return false;

  const threshold = Number(programLean.award_rule_threshold || 0);
  const lifetimeMerged = opts.lifetimeMerged instanceof Map ? opts.lifetimeMerged : null;

  if (kind === "student_total_xp_milestone") {
    const merged = lifetimeMerged || (await buildRowsForSubmittedFilter({}));
    const xpTotal = Math.max(0, Number(merged.get(String(sid))?.xp || 0));
    if (xpTotal < threshold) return false;

    const already = await StudentAchievementBadge.exists({
      student_id: oid,
      badge_code: code,
      award_period: "",
    });
    if (already) return false;

    try {
      await StudentAchievementBadge.create({
        student_id: oid,
        badge_code: code,
        category: "program",
        title: programLean.title,
        description: programLean.description || "",
        threshold_value: threshold,
        icon_key: programLean.icon_key || "trophy",
        accent: programLean.accent || "amber",
        custom_image_url: String(programLean.custom_image_url || "").trim(),
        badge_layout:
          programLean.badge_layout && typeof programLean.badge_layout === "object"
            ? normalizeBadgeLayout(programLean.badge_layout)
            : null,
        awarded_at: new Date(),
        award_period: "",
      });
      return true;
    } catch (err) {
      if (err && err.code === 11000) return false;
      throw err;
    }
  }

  if (kind === "arena_distinct_solved" || kind === "arena_best_streak_ist") {
    const qIds = await batchArenaQuestionIdsForStudent(sid);
    const [questsSolved, bestStreak] = await Promise.all([
      countDistinctArenaQuestsSolved(sid, qIds),
      bestArenaAcceptedStreakDaysIst(sid, qIds),
    ]);

    if (!qualifiesArena(programLean, questsSolved, bestStreak)) return false;

    const already = await StudentAchievementBadge.exists({
      student_id: oid,
      badge_code: code,
      award_period: "",
    });
    if (already) return false;

    try {
      await StudentAchievementBadge.create({
        student_id: oid,
        badge_code: code,
        category: "program",
        title: programLean.title,
        description: programLean.description || "",
        threshold_value: threshold,
        icon_key: programLean.icon_key || "trophy",
        accent: programLean.accent || "amber",
        custom_image_url: String(programLean.custom_image_url || "").trim(),
        badge_layout:
          programLean.badge_layout && typeof programLean.badge_layout === "object"
            ? normalizeBadgeLayout(programLean.badge_layout)
            : null,
        awarded_at: new Date(),
        award_period: "",
      });
      return true;
    } catch (err) {
      if (err && err.code === 11000) return false;
      throw err;
    }
  }

  return false;
}

async function grantMonthlyXpProgramsForStudent(studentId, programLean, mergedCache) {
  const sid = String(studentId);
  if (!mongoose.Types.ObjectId.isValid(sid)) return false;
  const oid = new mongoose.Types.ObjectId(sid);
  const code = String(programLean.badge_code || "").trim().toLowerCase();
  if (!code || String(programLean.award_rule_kind) !== "assignment_monthly_ist_xp") return false;

  const threshold = Number(programLean.award_rule_threshold || 0);
  const now = new Date();
  let grantedAny = false;

  const cache = mergedCache instanceof Map ? mergedCache : new Map();
  const periods = recentClosedIndianMonthPeriods(18, now);

  for (const period of periods) {
    if (!monthlyPeriodEvaluable(programLean, period, now)) continue;

    const exists = await StudentAchievementBadge.exists({
      student_id: oid,
      badge_code: code,
      award_period: period,
    });
    if (exists) continue;

    let merged = cache.get(period);
    if (!merged) {
      const p = parsePeriodYm(period);
      if (!p) continue;
      merged = await buildRowsForSubmittedFilter(submittedAtIndiaCalendarMonth(p.y, p.mo));
      cache.set(period, merged);
    }

    const xpRow = merged.get(String(sid));
    const xp = Math.max(0, Number(xpRow?.xp || 0));
    if (xp < threshold) continue;

    try {
      await StudentAchievementBadge.create({
        student_id: oid,
        badge_code: code,
        category: "program",
        title: programLean.title,
        description: programLean.description || "",
        threshold_value: threshold,
        icon_key: programLean.icon_key || "trophy",
        accent: programLean.accent || "amber",
        custom_image_url: String(programLean.custom_image_url || "").trim(),
        badge_layout:
          programLean.badge_layout && typeof programLean.badge_layout === "object"
            ? normalizeBadgeLayout(programLean.badge_layout)
            : null,
        awarded_at: new Date(),
        award_period: period,
      });
      grantedAny = true;
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
    }
  }

  return grantedAny;
}

/** @deprecated Prefer grantArenaOrLifetimeProgramBadge — kept name for callers. */
async function grantProgramBadgeIfEligible(studentId, programLean, opts = {}) {
  return grantArenaOrLifetimeProgramBadge(studentId, programLean, opts);
}

async function ensurePublishedProgramBadgesForStudent(studentId) {
  const programs = await BadgeProgram.find({ status: "published" }).lean();
  const monthlyCache = new Map();
  let lifetimeMerged = null;
  for (const p of programs) {
    if (String(p.award_rule_kind) === "assignment_monthly_ist_xp") {
      /* eslint-disable no-await-in-loop */
      await grantMonthlyXpProgramsForStudent(studentId, p, monthlyCache);
      /* eslint-enable no-await-in-loop */
    } else if (String(p.award_rule_kind) === "student_total_xp_milestone") {
      if (!lifetimeMerged) lifetimeMerged = await buildRowsForSubmittedFilter({});
      /* eslint-disable no-await-in-loop */
      await grantArenaOrLifetimeProgramBadge(studentId, p, { lifetimeMerged });
      /* eslint-enable no-await-in-loop */
    } else {
      /* eslint-disable no-await-in-loop */
      await grantArenaOrLifetimeProgramBadge(studentId, p);
      /* eslint-enable no-await-in-loop */
    }
  }
}

async function awardAllStudentsForPublishedProgram(programId) {
  const program = await BadgeProgram.findById(programId).lean();
  if (!program || program.status !== "published") return { awarded_hints: 0, students_checked: 0 };

  const students = await Student.find({ role: "student" }).select("_id").lean();
  let hints = 0;

  if (String(program.award_rule_kind) === "assignment_monthly_ist_xp") {
    const mergedCache = new Map();
    for (const s of students) {
      /* eslint-disable no-await-in-loop */
      const ok = await grantMonthlyXpProgramsForStudent(String(s._id), program, mergedCache);
      if (ok) hints += 1;
      /* eslint-enable no-await-in-loop */
    }
    return { awarded_hints: hints, students_checked: students.length };
  }

  if (String(program.award_rule_kind) === "student_total_xp_milestone") {
    const merged = await buildRowsForSubmittedFilter({});
    for (const s of students) {
      /* eslint-disable no-await-in-loop */
      const ok = await grantArenaOrLifetimeProgramBadge(String(s._id), program, { lifetimeMerged: merged });
      if (ok) hints += 1;
      /* eslint-enable no-await-in-loop */
    }
    return { awarded_hints: hints, students_checked: students.length };
  }

  for (const s of students) {
    /* eslint-disable no-await-in-loop */
    const ok = await grantArenaOrLifetimeProgramBadge(String(s._id), program);
    if (ok) hints += 1;
    /* eslint-enable no-await-in-loop */
  }

  return { awarded_hints: hints, students_checked: students.length };
}

function normalizeMonthlyFields(payload = {}) {
  const modeRaw = String(payload.monthly_evaluation || "ist_auto").trim();
  const monthly_evaluation =
    modeRaw === "ist_custom_dom" ? "ist_custom_dom" : "ist_auto";
  let monthly_custom_dom = null;
  if (monthly_evaluation === "ist_custom_dom" && payload.monthly_custom_dom != null) {
    const d = Number(payload.monthly_custom_dom);
    if (Number.isFinite(d)) monthly_custom_dom = Math.min(31, Math.max(1, Math.floor(d)));
  }
  return { monthly_evaluation, monthly_custom_dom };
}

async function createDraft(payload) {
  const title = String(payload.title || "").trim();
  if (!title) throw Object.assign(new Error("TITLE_REQUIRED"), { code: "TITLE_REQUIRED" });

  const kind = String(payload.award_rule_kind || "").trim();
  if (!AWARD_KINDS.has(kind)) {
    throw Object.assign(new Error("INVALID_RULE_KIND"), { code: "INVALID_RULE_KIND" });
  }

  const threshold = coerceThreshold(kind, payload.award_rule_threshold);
  const monthly =
    kind === "assignment_monthly_ist_xp"
      ? normalizeMonthlyFields(payload)
      : { monthly_evaluation: "ist_auto", monthly_custom_dom: null };

  const badge_code = await generateUniqueBadgeCode(title);

  const docPayload = {
    badge_code,
    title,
    description: String(payload.description || "").trim().slice(0, 500),
    icon_key: payload.icon_key || "trophy",
    accent: payload.accent || "amber",
    status: "draft",
    award_rule_kind: kind,
    award_rule_threshold: threshold,
    monthly_evaluation: monthly.monthly_evaluation,
    monthly_custom_dom: monthly.monthly_custom_dom,
    published_at: null,
    custom_image_url: String(payload.custom_image_url ?? "").trim().slice(0, 2000),
    badge_layout: normalizeBadgeLayout(payload.badge_layout),
  };

  return BadgeProgram.create(docPayload);
}

async function updateProgram(id, payload, opts = {}) {
  const doc = await BadgeProgram.findById(id);
  if (!doc) return null;

  const isPublished = doc.status === "published";

  if (payload.title != null && (!isPublished || String(payload.title).trim())) {
    doc.title = String(payload.title).trim().slice(0, 120);
  }
  if (payload.description != null) doc.description = String(payload.description).trim().slice(0, 500);
  if (payload.icon_key != null) doc.icon_key = payload.icon_key;
  if (payload.accent != null) doc.accent = payload.accent;

  if (payload.custom_image_url != null) {
    doc.custom_image_url = String(payload.custom_image_url || "").trim().slice(0, 2000);
  }
  if (payload.badge_layout != null) {
    doc.badge_layout = normalizeBadgeLayout(payload.badge_layout);
  }

  if (!isPublished) {
    if (payload.award_rule_kind != null) {
      const k = String(payload.award_rule_kind).trim();
      if (AWARD_KINDS.has(k)) doc.award_rule_kind = k;
    }
    if (payload.award_rule_threshold != null) {
      doc.award_rule_threshold = coerceThreshold(doc.award_rule_kind, payload.award_rule_threshold);
    }

    const kindEffective = doc.award_rule_kind;
    if (kindEffective !== "assignment_monthly_ist_xp") {
      doc.monthly_evaluation = "ist_auto";
      doc.monthly_custom_dom = null;
    } else {
      const monthly = normalizeMonthlyFields(payload);
      doc.monthly_evaluation = monthly.monthly_evaluation;
      doc.monthly_custom_dom =
        monthly.monthly_evaluation === "ist_custom_dom" ? monthly.monthly_custom_dom : null;
    }
  }

  if (opts.publish && doc.status === "draft") {
    doc.status = "published";
    doc.published_at = new Date();
  }

  await doc.save();
  return doc;
}

/**
 * Push display snapshot onto every StudentAchievementBadge for this badge_code (all award_period rows).
 */
async function syncEarnedProgramBadgesFromProgram(programDoc) {
  const status =
    typeof programDoc?.get === "function" ? programDoc.get("status") : programDoc?.status;
  if (status !== "published") return { student_badges_updated: 0 };

  const code = String(programDoc.badge_code || "").trim().toLowerCase();
  if (!code) return { student_badges_updated: 0 };

  const title = String(programDoc.title || "").trim();
  const description = String(programDoc.description || "").trim();
  const icon_key = programDoc.icon_key || "trophy";
  const accent = programDoc.accent || "amber";
  const threshold_value = Math.max(1, Math.floor(Number(programDoc.award_rule_threshold || 1)));
  const custom_image_url = String(
    typeof programDoc.get === "function" ? programDoc.get("custom_image_url") : programDoc.custom_image_url || ""
  ).trim();
  const rawLayout =
    typeof programDoc.get === "function" ? programDoc.get("badge_layout") : programDoc.badge_layout;
  const badge_layout =
    rawLayout && typeof rawLayout === "object" ? normalizeBadgeLayout(rawLayout) : null;

  const res = await StudentAchievementBadge.updateMany(
    { badge_code: code, category: "program" },
    {
      $set: {
        title,
        description,
        icon_key,
        accent,
        threshold_value,
        custom_image_url,
        badge_layout,
      },
    }
  );
  const n =
    typeof res.modifiedCount === "number" ? res.modifiedCount : Number(res?.nModified || 0);
  return { student_badges_updated: n };
}

async function deleteBadgeProgram(programId) {
  const sid = String(programId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(sid)) {
    return { ok: false, removed_student_badges: 0 };
  }
  const doc = await BadgeProgram.findById(sid).lean();
  if (!doc) return { ok: false, removed_student_badges: 0 };

  const code = String(doc.badge_code || "").trim().toLowerCase();
  let removed = 0;
  if (code) {
    const result = await StudentAchievementBadge.deleteMany({ badge_code: code, category: "program" });
    removed = typeof result.deletedCount === "number" ? result.deletedCount : Number(result?.n || 0);
  }
  await BadgeProgram.deleteOne({ _id: sid });
  return { ok: true, removed_student_badges: removed };
}

module.exports = {
  generateUniqueBadgeCode,
  ensurePublishedProgramBadgesForStudent,
  awardAllStudentsForPublishedProgram,
  syncEarnedProgramBadgesFromProgram,
  createDraft,
  updateProgram,
  deleteBadgeProgram,
  normalizeBadgeLayout,
  grantProgramBadgeIfEligible,
};
