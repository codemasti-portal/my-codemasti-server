const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const MonthlyLeaderboardBadge = require("../models/MonthlyLeaderboardBadge");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { membershipMode, resolveStudentBatchIds } = require("../utils/student-batch-context");
const monthlyBadgeSvc = require("../services/monthly-leaderboard-badge.service");

// Resolve the cohort scope for monthly winners: honor a requested batch_id ONLY when the student
// actually belongs to it (so a switcher can't peek at arbitrary batches); otherwise the primary.
async function resolveWinnersScopeKey(rawStudent, requestedBatchId) {
  const s = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  const fallback = monthlyBadgeSvc.scopeKeyForStudentLean(s);
  const want = String(requestedBatchId || "").toLowerCase().trim();
  if (!want) return fallback;
  const mode = membershipMode();
  if (mode === "legacy") {
    return want === String(s.batch_id || "").toLowerCase().trim() ? want : fallback;
  }
  const { batchIds } = await resolveStudentBatchIds(rawStudent, { mode });
  return batchIds.includes(want) ? want : fallback;
}

/**
 * Winners for caller's leaderboard cohort — used on leaderboard hall-of-fame + badge icons on rows.
 */
async function leaderboardMonthlyWinners(req, res) {
  try {
    const rawStudent = await Student.findById(req.user.sub).lean();
    if (!rawStudent) {
      return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
    }
    const scope_key = await resolveWinnersScopeKey(rawStudent, req.query.batch_id);
    await monthlyBadgeSvc.ensureRecentMonthsForScope(scope_key, 8);
    const limit = Math.min(48, Math.max(3, Number(req.query.limit) || 12));

    const [winners, badge_holder_student_ids] = await Promise.all([
      monthlyBadgeSvc.listWinnersForScope(scope_key, { limit }),
      // serverApi.strict:true bans `distinct` — dedupe student ids in app code.
      MonthlyLeaderboardBadge.find({ scope_key })
        .select("student_id")
        .lean()
        .then((rows) => [...new Set(rows.map((r) => String(r.student_id)))]),
    ]);

    const data = winners.map((w) => ({
      period: w.period,
      xp: Number(w.xp || 0),
      badge_code: w.badge_code,
      title: w.title || "Student of the Month",
      description: w.description || "",
      student_id: String(w.student_id),
      student_name: w.student_name_snapshot || "",
      avatar_url: w.avatar_url_snapshot || "",
      finalized_at: w.finalized_at ? new Date(w.finalized_at).toISOString() : null,
      icon_key: w.icon_key || "trophy",
      accent: w.accent || "amber",
    }));

    return sendSuccess(res, {
      scope_key,
      winners: data,
      badge_holder_student_ids,
    });
  } catch (err) {
    return sendError(
      res,
      500,
      "MONTHLY_BADGES_FAILED",
      err?.message ? String(err.message) : "Failed to load monthly winners"
    );
  }
}

/**
 * Caller’s earned badges (any cohort they belonged to when the badge row was minted shares student_id match).
 */
async function myMonthlyBadges(req, res) {
  try {
    const rawStudent = await Student.findById(req.user.sub).lean();
    if (!rawStudent) {
      return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
    }
    const s = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
    const scope_key = monthlyBadgeSvc.scopeKeyForStudentLean(s);
    await monthlyBadgeSvc.ensureRecentMonthsForScope(scope_key, 6);

    const rows = await monthlyBadgeSvc.listBadgesForStudent(req.user.sub);
    const data = rows.map((w) => ({
      period: w.period,
      xp: Number(w.xp || 0),
      badge_code: w.badge_code,
      title: w.title || "Student of the Month",
      description: w.description || "",
      scope_key: w.scope_key,
      student_name: w.student_name_snapshot || "",
      avatar_url: w.avatar_url_snapshot || "",
      finalized_at: w.finalized_at ? new Date(w.finalized_at).toISOString() : null,
      icon_key: w.icon_key || "trophy",
      accent: w.accent || "amber",
    }));
    return sendSuccess(res, data);
  } catch (err) {
    return sendError(
      res,
      500,
      "MY_MONTHLY_BADGES_FAILED",
      err?.message ? String(err.message) : "Failed to load badges"
    );
  }
}

module.exports = { leaderboardMonthlyWinners, myMonthlyBadges };
