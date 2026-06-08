const mongoose = require("mongoose");
const Student = require("../models/Student");
const MonthlyLeaderboardBadge = require("../models/MonthlyLeaderboardBadge");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { resolveStudentBatchIds, catalogBatchMongoMatchResolved } = require("../utils/student-batch-context");
const {
  submittedAtIndiaCalendarMonth,
  recentClosedIndianMonthPeriods,
  isIndianCalendarPeriodEligibleForFinalization,
} = require("../utils/india-time");
const { buildRowsForSubmittedFilter } = require("../controllers/leaderboard.controller");
const badgeDefSvc = require("./achievement-badge-definition.service");

function parsePeriod(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { year: y, month: mo };
}

function isPeriodEligibleForFinalization(period, nowDate = new Date()) {
  return isIndianCalendarPeriodEligibleForFinalization(period, nowDate);
}

function scopeKeyForStudentLean(studentLean) {
  const s = augmentStudentCatalogFieldsFromEnrollment(studentLean);
  const bid = String(s.batch_id || "").trim().toLowerCase();
  if (bid) return bid;
  return `solo:${String(s._id)}`;
}

async function distinctScopeKeys() {
  const rows = await Student.find({ role: "student" }).select("_id batch_id enrollment_number").lean();
  const keys = new Set();
  for (const row of rows) {
    // A multi-batch student contributes a cohort key for EACH active batch.
    const { batchIds } = await resolveStudentBatchIds(row);
    if (batchIds.length) {
      for (const b of batchIds) keys.add(b);
    } else {
      keys.add(`solo:${String(row._id)}`);
    }
  }
  return [...keys];
}

/**
 * Persist top earner for one cohort + India (IST) calendar month when missing. No-op unless the month ended.
 */
async function finalizePeriodForScopeIfMissing(scopeKey, period) {
  if (!scopeKey || !period) return null;
  if (!isPeriodEligibleForFinalization(period)) return null;

  const existing = await MonthlyLeaderboardBadge.findOne({ scope_key: scopeKey, period }).lean();
  if (existing) return existing;

  const p = parsePeriod(period);
  if (!p) return null;

  const submittedFilter = submittedAtIndiaCalendarMonth(p.year, p.month);
  // Per-batch scope: in non-legacy mode a cohort's "Student of the Month" counts only that batch's
  // own content. Legacy stays global (byte-identical); solo (no-batch) students stay global too.
  const scopeBatchIds = scopeKey.startsWith("solo:") ? undefined : [scopeKey];
  const merged = await buildRowsForSubmittedFilter(
    submittedFilter,
    scopeBatchIds ? { batchIds: scopeBatchIds } : undefined
  );

  let students;
  if (scopeKey.startsWith("solo:")) {
    const id = scopeKey.slice(5).trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    students = await Student.find({ _id: id, role: "student" }).select("_id name avatar_url").lean();
  } else {
    students = await Student.find({
      role: "student",
      ...(await catalogBatchMongoMatchResolved(scopeKey)),
    })
      .select("_id name avatar_url")
      .lean();
  }

  const ranked = students
    .map((stu) => {
      const sid = String(stu._id);
      const v = merged.get(sid);
      const xp = Math.max(0, Number(v?.xp || 0));
      return { id: sid, name: stu.name || "", avatar_url: stu.avatar_url || "", xp };
    })
    .sort((a, b) => b.xp - a.xp || (a.name || "").localeCompare(b.name || ""));

  const winner = ranked[0];
  if (!winner || winner.xp <= 0) {
    return null;
  }

  const pres = await badgeDefSvc.getPublishedPresentation(badgeDefSvc.MONTHLY_BADGE_CODE);

  try {
    const doc = await MonthlyLeaderboardBadge.create({
      period,
      scope_key: scopeKey,
      student_id: winner.id,
      xp: winner.xp,
      badge_code: badgeDefSvc.MONTHLY_BADGE_CODE,
      title: pres.title,
      description: pres.description || "",
      icon_key: pres.icon_key,
      accent: pres.accent,
      student_name_snapshot: winner.name,
      avatar_url_snapshot: winner.avatar_url,
      finalized_at: new Date(),
    });
    return doc.toObject();
  } catch (err) {
    if (err && err.code === 11000) {
      return MonthlyLeaderboardBadge.findOne({ scope_key: scopeKey, period }).lean();
    }
    throw err;
  }
}

function recentClosedPeriods(count, nowDate = new Date()) {
  return recentClosedIndianMonthPeriods(count, nowDate);
}

/**
 * Finalize last N IST months for **one cohort** only — used from student leaderboard/profile flows.
 */
async function ensureRecentMonthsForScope(scopeKey, monthsBack = 4, nowDate = new Date()) {
  if (!scopeKey) return;
  const periods = recentClosedPeriods(monthsBack, nowDate);
  for (const period of periods) {
    try {
      await finalizePeriodForScopeIfMissing(scopeKey, period);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Finalize last N closed months for every cohort (idempotent).
 */
async function ensureRecentMonthsFinalized({ monthsBack = 4 } = {}) {
  const periods = recentClosedPeriods(monthsBack);
  const scopeKeys = await distinctScopeKeys();
  for (const period of periods) {
    for (const sk of scopeKeys) {
      try {
        await finalizePeriodForScopeIfMissing(sk, period);
      } catch {
        /* ignore per-scope failures */
      }
    }
  }
}

async function listWinnersForScope(scopeKey, { limit = 12 } = {}) {
  if (!scopeKey) return [];
  return MonthlyLeaderboardBadge.find({ scope_key: scopeKey })
    .sort({ period: -1 })
    .limit(Math.min(48, Math.max(1, limit)))
    .lean();
}

async function listBadgesForStudent(studentId) {
  return MonthlyLeaderboardBadge.find({ student_id: studentId }).sort({ period: -1 }).lean();
}

module.exports = {
  scopeKeyForStudentLean,
  ensureRecentMonthsForScope,
  ensureRecentMonthsFinalized,
  listWinnersForScope,
  listBadgesForStudent,
  parsePeriod,
  isPeriodEligibleForFinalization,
};
