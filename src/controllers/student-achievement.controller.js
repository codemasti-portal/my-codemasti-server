const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { resolveDefaultBatchBoard } = require("../utils/student-batch-context");
const monthlySvc = require("../services/monthly-leaderboard-badge.service");
const achievementSvc = require("../services/student-achievement.service");
const badgeProgramSvc = require("../services/badge-program.service");
const weeklyClimbSvc = require("../services/weekly-climb-badge.service");

async function combinedAchievements(req, res) {
  try {
    const rawStudent = await Student.findById(req.user.sub).lean();
    if (!rawStudent) {
      return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
    }
    const s = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
    const scopeKey = monthlySvc.scopeKeyForStudentLean(s);

    await Promise.all([
      achievementSvc.ensureMilestoneBadges(req.user.sub),
      achievementSvc.ensureGapOvertakeBadge(req.user.sub),
      badgeProgramSvc.ensurePublishedProgramBadgesForStudent(req.user.sub),
      monthlySvc.ensureRecentMonthsForScope(scopeKey, 6),
      weeklyClimbSvc.ensureRecentWeeksForStudent(s, 6),
    ]);

    const [milestonesLean, monthlyLean, batchScope] = await Promise.all([
      achievementSvc.listMilestoneBadgesForStudent(req.user.sub),
      monthlySvc.listBadgesForStudent(req.user.sub),
      resolveDefaultBatchBoard(s),
    ]);

    const codes = [...new Set(milestonesLean.map((r) => String(r.badge_code || "").trim().toLowerCase()).filter(Boolean))];
    const rarityCounts =
      codes.length && batchScope.ids.length
        ? await StudentAchievementBadge.aggregate([
            { $match: { badge_code: { $in: codes }, student_id: { $in: batchScope.ids } } },
            { $group: { _id: "$badge_code", n: { $sum: 1 } } },
          ])
        : [];
    const rarityByCode = new Map(rarityCounts.map((c) => [String(c._id), Number(c.n || 0)]));
    const batch_size = batchScope.ids.length;
    const batch_name = batchScope.batchName;

    const milestones = milestonesLean.map((row) => ({
      badge_code: row.badge_code,
      category: row.category,
      title: row.title,
      description: row.description || "",
      threshold_value: Number(row.threshold_value || 0),
      awarded_at: row.awarded_at ? new Date(row.awarded_at).toISOString() : null,
      award_period: row.award_period ? String(row.award_period) : "",
      icon_key: row.icon_key || "",
      accent: row.accent || "",
      custom_image_url: row.custom_image_url || "",
      badge_layout:
        row.badge_layout && typeof row.badge_layout === "object" ? row.badge_layout : null,
      earned_count_in_batch: batch_size ? rarityByCode.get(String(row.badge_code || "").trim().toLowerCase()) || 0 : 0,
      batch_size,
      batch_name,
    }));

    const monthly_leaderboard = monthlyLean.map((w) => ({
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

    return sendSuccess(res, {
      milestones,
      monthly_leaderboard,
    });
  } catch (err) {
    return sendError(
      res,
      500,
      "ACHIEVEMENTS_FAILED",
      err?.message ? String(err.message) : "Failed to load achievements"
    );
  }
}

module.exports = { combinedAchievements };
