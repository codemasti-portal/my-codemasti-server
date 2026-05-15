const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");

async function listMilestoneAchievementBadges(req, res) {
  try {
    const limit = Math.min(600, Math.max(1, Number(req.query.limit) || 200));
    const skip = Math.min(20_000, Math.max(0, Number(req.query.skip) || 0));

    const q = {};
    if (req.query.badge_code?.trim()) q.badge_code = String(req.query.badge_code).trim();
    if (req.query.category?.trim()) q.category = String(req.query.category).trim();
    if (req.query.student_id?.trim() && mongoose.Types.ObjectId.isValid(req.query.student_id.trim())) {
      q.student_id = new mongoose.Types.ObjectId(req.query.student_id.trim());
    }

    const [items, total] = await Promise.all([
      StudentAchievementBadge.find(q).sort({ awarded_at: -1 }).skip(skip).limit(limit).lean(),
      StudentAchievementBadge.countDocuments(q),
    ]);

    const data = items.map((row) => ({
      badge_code: row.badge_code,
      category: row.category,
      title: row.title,
      description: row.description || "",
      threshold_value: Number(row.threshold_value || 0),
      student_id: String(row.student_id),
      awarded_at: row.awarded_at ? new Date(row.awarded_at).toISOString() : null,
      icon_key: row.icon_key || "",
      accent: row.accent || "",
    }));

    return sendSuccess(res, data, "", { total, skip, limit });
  } catch (err) {
    return sendError(res, 500, "MILESTONE_BADGE_ADMIN_LIST_FAILED", err?.message || "Failed to list milestone badges");
  }
}

module.exports = { listMilestoneAchievementBadges };
