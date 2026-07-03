const mongoose = require("mongoose");
const { sendSuccess } = require("../utils/response");
const Student = require("../models/Student");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");
const MonthlyLeaderboardBadge = require("../models/MonthlyLeaderboardBadge");
const achievementSvc = require("../services/student-achievement.service");
const monthlySvc = require("../services/monthly-leaderboard-badge.service");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const {
  resolveStudentBatchIds,
  studentIdsInBatches,
} = require("../utils/student-batch-context");
const registry = require("../utils/batch-catalog-registry");
const { toIndiaCalendarYmd } = require("../utils/india-time");
const { buildRows, buildLatestSubmissionMap } = require("../services/xp-aggregation.service");

// Resolve the leaderboard "board" for a viewer. A board is ONE batch: cohort = students in that
// batch, XP limited to that batch's content. requestedBatchId picks the board; default = the
// student's primary batch (Student.batch_id) else their first batch. Returns the full batch list
// (availableBatches) so the client can render a per-batch switcher for multi-batch students.
async function getScopedStudentIdSet(studentId, requestedBatchId) {
  const rawStudent = await Student.findById(studentId).lean();
  const studentDoc = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!studentDoc) return null;

  // Resolve the student's batches, then scope the board to ONE batch.
  const { batchIds } = await resolveStudentBatchIds(studentId);
  if (!batchIds.length) {
    return { ids: new Set(), batchIds: [], availableBatches: [], selectedBatch: null };
  }
  const want = String(requestedBatchId || "").toLowerCase().trim();
  const primary = String(studentDoc.batch_id || "").toLowerCase().trim();
  const board =
    (want && batchIds.includes(want) && want) ||
    (primary && batchIds.includes(primary) && primary) ||
    batchIds[0];

  const ids = new Set((await studentIdsInBatches([board])).map(String));
  return { ids, batchIds: [board], availableBatches: batchIds, selectedBatch: board };
}

const TIME_FILTERS = ["all_time", "this_year", "this_month", "this_week", "month"];

/** "YYYY-MM" or undefined -- only meaningful when time_filter=month (picking a specific past
 * month from the leaderboard filter, distinct from the relative "this_month" bucket). */
function parseMonthParam(raw) {
  return /^\d{4}-\d{2}$/.test(String(raw || "").trim()) ? String(raw).trim() : undefined;
}

async function list(req, res) {
  const raw = String(req.query.time_filter || "all_time");
  const tf = TIME_FILTERS.includes(raw) ? raw : "all_time";
  const month = parseMonthParam(req.query.month);
  const scope = await getScopedStudentIdSet(req.user.sub, req.query.batch_id);
  if (!scope) {
    return sendSuccess(res, []);
  }
  const scopedStudentIds = scope.ids;
  const xpOpts = scope.batchIds.length ? { batchIds: scope.batchIds } : undefined;

  const ids = [...scopedStudentIds].map((id) => new mongoose.Types.ObjectId(id));

  const [merged, latestSubmissionMap, students, milestoneCounts, monthlyCounts] = await Promise.all([
    buildRows(tf, xpOpts, month),
    buildLatestSubmissionMap(tf, month),
    ids.length ? Student.find({ _id: { $in: ids } }).lean() : Promise.resolve([]),
    // Batchmates' total badge count -- shown as a small indicator next to their name so badges
    // have visibility beyond the earner's own private Achievements page.
    ids.length
      ? StudentAchievementBadge.aggregate([
          { $match: { student_id: { $in: ids } } },
          { $group: { _id: "$student_id", n: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
    ids.length
      ? MonthlyLeaderboardBadge.aggregate([
          { $match: { student_id: { $in: ids } } },
          { $group: { _id: "$student_id", n: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
  ]);
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const badgeCountById = new Map();
  for (const row of milestoneCounts) badgeCountById.set(String(row._id), Number(row.n || 0));
  for (const row of monthlyCounts) {
    const id = String(row._id);
    badgeCountById.set(id, (badgeCountById.get(id) || 0) + Number(row.n || 0));
  }

  const rows = ids
    .map((oid) => String(oid))
    .map((id) => {
      const s = byId.get(id);
      const v = merged.get(id) || { xp: 0, last: new Date(0) };
      if (!s) return null;
      return {
        id,
        name: s.name,
        avatar_url: s.avatar_url || "",
        xp: Math.max(0, Number(v.xp || 0)),
        batch: s.batch || "",
        badges_earned_count: badgeCountById.get(id) || 0,
        latest_submission_time:
          (latestSubmissionMap.get(id) || v.last) > new Date(0)
            ? (latestSubmissionMap.get(id) || v.last).toISOString()
            : null,
      };
    })
    .filter(Boolean);
  rows.sort((a, b) => b.xp - a.xp || (a.name || "").localeCompare(b.name || ""));
  const ranked = rows.map((r, idx) => ({
    ...r,
    rank: idx + 1,
    previous_rank: null,
  }));

  return sendSuccess(res, ranked);
}

async function me(req, res) {
  const raw = String(req.query.time_filter || "all_time");
  const tf = TIME_FILTERS.includes(raw) ? raw : "all_time";
  const month = parseMonthParam(req.query.month);

  // Streak + badge count reflect the student's true current standing, independent of the
  // time_filter/batch_id board being viewed — they shouldn't jump around as filters change.
  const [scope, dayKeys, milestoneCount, rawStudentForScope] = await Promise.all([
    getScopedStudentIdSet(req.user.sub, req.query.batch_id),
    achievementSvc.unionAcceptedActivityDayKeysIst(req.user.sub),
    StudentAchievementBadge.countDocuments({ student_id: req.user.sub }),
    Student.findById(req.user.sub).select("enrollment_number").lean(),
  ]);
  const { current_streak, active_today } = achievementSvc.currentIstStreakFromSortedDays(
    dayKeys,
    toIndiaCalendarYmd(new Date())
  );

  // Student-of-the-Month badges are only ever created lazily (on first visit to a page that
  // checks for them) — ensure this student's recent months are finalized before counting, same
  // as the Profile achievements page and the Leaderboard's own "Student of the Month" widget
  // already do.
  if (rawStudentForScope) {
    const scopeKey = monthlySvc.scopeKeyForStudentLean(rawStudentForScope);
    await monthlySvc.ensureRecentMonthsForScope(scopeKey, 6);
  }
  const monthlyBadgeCount = await MonthlyLeaderboardBadge.countDocuments({ student_id: req.user.sub });
  const badges_earned_count = milestoneCount + monthlyBadgeCount;

  if (!scope) {
    return sendSuccess(res, {
      rank: null,
      xp: 0,
      time_filter: tf,
      latest_submission_time: null,
      selected_batch_id: null,
      batches: [],
      current_streak,
      streak_active_today: active_today,
      badges_earned_count,
    });
  }
  const scopedStudentIds = scope.ids;
  const xpOpts = scope.batchIds.length ? { batchIds: scope.batchIds } : undefined;

  const [merged, latestSubmissionMap] = await Promise.all([
    buildRows(tf, xpOpts, month),
    buildLatestSubmissionMap(tf, month),
  ]);
  const selfId = String(req.user.sub);
  const entry = merged.get(selfId);
  const myXp = entry?.xp ?? 0;
  const myLast = latestSubmissionMap.get(selfId) || entry?.last;

  const sorted = [...scopedStudentIds]
    .map((id) => [id, merged.get(id) || { xp: 0, last: new Date(0) }])
    .sort((a, b) => Number(b[1].xp || 0) - Number(a[1].xp || 0) || String(a[0]).localeCompare(String(b[0])));
  const rankIdx = sorted.findIndex(([id]) => id === selfId);

  // Expose the student's batches so the client can show a per-batch switcher (multi-batch only).
  const batches = (scope.availableBatches || []).map((b) => ({
    batch_id: b,
    name: registry.displayNameSync(b) || b,
  }));

  return sendSuccess(res, {
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    xp: myXp,
    time_filter: tf,
    latest_submission_time: myLast && myLast > new Date(0) ? myLast.toISOString() : null,
    selected_batch_id: scope.selectedBatch,
    batches,
    current_streak,
    streak_active_today: active_today,
    badges_earned_count,
  });
}

module.exports = {
  list,
  me,
};
