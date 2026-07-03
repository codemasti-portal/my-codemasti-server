const mongoose = require("mongoose");
const Student = require("../models/Student");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaSubmission = require("../models/ArenaSubmission");
const { resolveDefaultBatchBoard } = require("../utils/student-batch-context");
const { indiaWeekStartInstant, indiaWeekKey } = require("../utils/india-time");
const { buildRowsForSubmittedFilter } = require("./xp-aggregation.service");

/**
 * "The Climb": a weekly badge for whoever gained the most all-time rank positions in their batch
 * that week — not whoever has the most XP. Deliberately mirrors monthly-leaderboard-badge.service.js's
 * "finalize on page visit, once ever, tolerate per-period failures" shape rather than a real cron:
 * this codebase has no scheduled-job infrastructure, so lazy finalization on the achievements page
 * is the existing pattern for recurring/periodic awards.
 */

const BADGE_CODE = "the_climb";
const MIN_WEEKLY_ACTIVITY = 5; // accepted submissions within the week, to clear the activity floor
const ACCEPTED_STATUS_ARENA = { $regex: /^accepted$/i };

/** Fully-elapsed Monday-to-Monday IST weeks, most-recent-closed first. */
function recentClosedWeeks(count, nowDate = new Date()) {
  const out = [];
  let cursor = indiaWeekStartInstant(nowDate).getTime();
  for (let i = 0; i < count; i += 1) {
    cursor -= 7 * 86400000;
    out.push({ weekStart: new Date(cursor), weekEnd: new Date(cursor + 7 * 86400000) });
  }
  return out;
}

/** All-time XP rank within one batch board, as of a specific instant (cumulative history strictly
 * before it) — reconstructable after the fact since every submission carries its own timestamp. */
async function rankAsOf(instant, board, studentIds) {
  const merged = await buildRowsForSubmittedFilter({ submitted_at: { $lt: instant } }, { batchIds: [board] });
  const sorted = studentIds
    .map((id) => String(id))
    .map((id) => [id, Number(merged.get(id)?.xp || 0)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rankById = new Map();
  sorted.forEach(([id], idx) => rankById.set(id, idx + 1));
  return rankById;
}

/** Accepted-submission counts within [weekStart, weekEnd) — the minimum-activity floor check. */
async function acceptedCountsInWindow(weekStart, weekEnd, studentObjectIds) {
  const [a, b] = await Promise.all([
    AssignmentSubmission.aggregate([
      { $match: { student_id: { $in: studentObjectIds }, status: "Accepted", submitted_at: { $gte: weekStart, $lt: weekEnd } } },
      { $group: { _id: "$student_id", n: { $sum: 1 } } },
    ]),
    ArenaSubmission.aggregate([
      {
        $match: {
          student_id: { $in: studentObjectIds },
          status: ACCEPTED_STATUS_ARENA,
          submitted_at: { $gte: weekStart, $lt: weekEnd },
        },
      },
      { $group: { _id: "$student_id", n: { $sum: 1 } } },
    ]),
  ]);
  const counts = new Map();
  for (const row of [...a, ...b]) {
    const id = String(row._id);
    counts.set(id, (counts.get(id) || 0) + Number(row.n || 0));
  }
  return counts;
}

/** Finalize one batch's one week if not already done. No-op (and cheap) once finalized. */
async function finalizeClimbForBoardWeekIfMissing(board, studentIds, weekStart, weekEnd) {
  const awardPeriod = `${indiaWeekKey(weekStart)}:${board}`;
  const existing = await StudentAchievementBadge.exists({ badge_code: BADGE_CODE, award_period: awardPeriod });
  if (existing) return null;

  const priorWeek2Start = new Date(weekStart.getTime() - 7 * 86400000);
  const studentObjectIds = studentIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const [rankAtEnd, rankAtStart, rankAtPrior2, activity] = await Promise.all([
    rankAsOf(weekEnd, board, studentIds),
    rankAsOf(weekStart, board, studentIds),
    rankAsOf(priorWeek2Start, board, studentIds),
    acceptedCountsInWindow(weekStart, weekEnd, studentObjectIds),
  ]);

  let best = null;
  for (const id of studentIds.map(String)) {
    if ((activity.get(id) || 0) < MIN_WEEKLY_ACTIVITY) continue;
    const endRank = rankAtEnd.get(id);
    const startRank = rankAtStart.get(id);
    if (!endRank || !startRank) continue;
    // Trailing 2-week average baseline (this week's start + the week before it) instead of a
    // single-week-over-single-week delta -- smooths out gaming the badge by staying quiet one
    // week purely to engineer a bigger apparent jump the next.
    const prior2Rank = rankAtPrior2.get(id);
    const baselineRank = prior2Rank ? (startRank + prior2Rank) / 2 : startRank;
    const gain = baselineRank - endRank;
    if (gain <= 0) continue;
    if (!best || gain > best.gain) best = { id, gain };
  }

  if (!best) return null;

  const roundedGain = Math.max(1, Math.round(best.gain));
  try {
    await StudentAchievementBadge.create({
      student_id: best.id,
      badge_code: BADGE_CODE,
      category: "leaderboard_climb",
      title: "The Climb",
      description: `Gained ${roundedGain} rank position${roundedGain === 1 ? "" : "s"} on the batch leaderboard this week.`,
      threshold_value: roundedGain,
      icon_key: "star",
      accent: "rose",
      awarded_at: new Date(),
      award_period: awardPeriod,
    });
    return { student_id: best.id, gain: roundedGain };
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}

/** Finalize the last N closed weeks for one batch board (idempotent, tolerates per-week failures). */
async function ensureRecentWeeksForBoard(board, studentIds, weeksBack = 6, nowDate = new Date()) {
  if (!board || !studentIds || !studentIds.length) return;
  const weeks = recentClosedWeeks(weeksBack, nowDate);
  for (const { weekStart, weekEnd } of weeks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await finalizeClimbForBoardWeekIfMissing(board, studentIds, weekStart, weekEnd);
    } catch {
      /* ignore per-week failures, same tolerance as monthly-leaderboard-badge.service.js */
    }
  }
}

/** Finalize the last N closed weeks for one student's own default batch — called from the
 * achievements page load, same trigger point as Student-of-the-Month finalization. */
async function ensureRecentWeeksForStudent(studentLean, weeksBack = 6) {
  const { board, ids } = await resolveDefaultBatchBoard(studentLean);
  if (!board) return;
  await ensureRecentWeeksForBoard(board, ids, weeksBack);
}

module.exports = {
  ensureRecentWeeksForBoard,
  ensureRecentWeeksForStudent,
};
