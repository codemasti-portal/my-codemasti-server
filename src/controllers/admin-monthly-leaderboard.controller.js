const { sendSuccess, sendError } = require("../utils/response");
const MonthlyLeaderboardBadge = require("../models/MonthlyLeaderboardBadge");
const monthlyBadgeSvc = require("../services/monthly-leaderboard-badge.service");

async function listMonthlyBadges(req, res) {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const skip = Math.min(10_000, Math.max(0, Number(req.query.skip) || 0));
    const q = {};
    if (req.query.period?.trim()) q.period = String(req.query.period).trim();
    if (req.query.scope_key?.trim()) q.scope_key = String(req.query.scope_key).trim();

    const [items, total] = await Promise.all([
      MonthlyLeaderboardBadge.find(q).sort({ period: -1, scope_key: 1 }).skip(skip).limit(limit).lean(),
      MonthlyLeaderboardBadge.countDocuments(q),
    ]);

    const data = items.map((row) => ({
      period: row.period,
      scope_key: row.scope_key,
      student_id: String(row.student_id),
      xp: Number(row.xp || 0),
      badge_code: row.badge_code,
      title: row.title || "Student of the Month",
      description: row.description || "",
      icon_key: row.icon_key || "trophy",
      accent: row.accent || "amber",
      student_name_snapshot: row.student_name_snapshot || "",
      avatar_url_snapshot: row.avatar_url_snapshot || "",
      finalized_at: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
    }));

    return sendSuccess(res, data, "", { total, skip, limit });
  } catch (err) {
    return sendError(res, 500, "BADGE_LIST_FAILED", err?.message || "Failed to list monthly badges");
  }
}

async function finalizeRecentMonthlyBadges(req, res) {
  try {
    const raw = req.body?.months_back ?? req.query?.months_back;
    const monthsBack = Math.min(24, Math.max(1, Number(raw) || 6));
    await monthlyBadgeSvc.ensureRecentMonthsFinalized({ monthsBack });
    return sendSuccess(res, { months_back: monthsBack }, "Monthly badge finalize pass completed.");
  } catch (err) {
    return sendError(res, 500, "BADGE_FINALIZE_FAILED", err?.message || "Failed to finalize badges");
  }
}

module.exports = { listMonthlyBadges, finalizeRecentMonthlyBadges };
