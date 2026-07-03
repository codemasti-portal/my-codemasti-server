const mongoose = require("mongoose");
const Student = require("../models/Student");
const ArenaQuestion = require("../models/ArenaQuestion");
const ArenaSubmission = require("../models/ArenaSubmission");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");
const StudentLeaderboardGapState = require("../models/StudentLeaderboardGapState");
const { resolveStudentBatchIds, resolveDefaultBatchBoard } = require("../utils/student-batch-context");
const { toIndiaCalendarYmd, indiaWeekKey } = require("../utils/india-time");
const { ARENA_QUEST_MILESTONES, ARENA_STREAK_BEST_MILESTONES } = require("../config/achievement-badges");
const badgeDefSvc = require("./achievement-badge-definition.service");
const { buildRows } = require("./xp-aggregation.service");

/** Same notion of “Accepted” as Arena list (case-insensitive). */
const ACCEPTED_STATUS = { $regex: /^accepted$/i };

function istUtcMidnightMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "").trim());
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00+05:30`).getTime();
}

/** Longest consecutive IST calendar streak from sorted ascending YYYY-MM-DD keys */
function longestIstCalendarStreakFromSortedDays(sortedYmD) {
  if (!sortedYmD?.length) return 0;
  let best = 1;
  let cur = 1;
  let lastMs = NaN;
  for (const key of sortedYmD) {
    const ms = istUtcMidnightMs(key);
    if (!Number.isFinite(ms)) continue;
    if (Number.isFinite(lastMs) && ms === lastMs + 86400000) {
      cur += 1;
    } else {
      cur = 1;
    }
    best = Math.max(best, cur);
    lastMs = ms;
  }
  return best;
}

async function batchArenaQuestionIdsForStudent(studentId) {
  const rawStudent = await Student.findById(studentId).select("batch batch_id enrollment_number").lean();
  if (!rawStudent) return [];
  // Membership is the full enrollment-derived batch set.
  const { batchIds } = await resolveStudentBatchIds(rawStudent);
  if (!batchIds.length) return [];

  const questions = await ArenaQuestion.find({
    $and: [
      { $or: batchIds.flatMap((b) => [{ batch_id: b }, { batch_ids: { $in: [b] } }]) },
      { $or: [{ is_disabled: false }, { is_disabled: { $exists: false } }] },
    ],
  })
    .select("_id")
    .lean();
  return questions.map((q) => q._id);
}

async function countDistinctArenaQuestsSolved(studentId, questionIds) {
  if (!questionIds.length) return 0;
  const oid = new mongoose.Types.ObjectId(String(studentId));
  const agg = await ArenaSubmission.aggregate([
    {
      $match: {
        student_id: oid,
        status: ACCEPTED_STATUS,
        question_id: { $in: questionIds },
      },
    },
    { $group: { _id: "$question_id" } },
    { $count: "n" },
  ]);
  return agg[0]?.n ?? 0;
}

async function bestArenaAcceptedStreakDaysIst(studentId, questionIds) {
  if (!questionIds.length) return 0;
  const oid = new mongoose.Types.ObjectId(String(studentId));
  const rows = await ArenaSubmission.find({
    student_id: oid,
    status: ACCEPTED_STATUS,
    question_id: { $in: questionIds },
  })
    .select("submitted_at")
    .lean();
  const daySet = new Set();
  for (const row of rows) {
    if (!row.submitted_at) continue;
    daySet.add(toIndiaCalendarYmd(row.submitted_at));
  }
  const sorted = [...daySet].sort();
  return longestIstCalendarStreakFromSortedDays(sorted);
}

/**
 * Portal-wide (Arena OR Assignment) accepted-activity IST day keys for a student.
 * Not batch-scoped — any accepted submission anywhere counts toward the daily streak.
 * Separate from bestArenaAcceptedStreakDaysIst(), which is Arena-only, batch-scoped,
 * and "best-ever" (used for streak badge thresholds — must stay untouched).
 */
// A CURRENT streak only needs enough recent history to find the latest unbroken run — it can
// never legitimately require the student's entire lifetime submission history, but this runs on
// every GET /leaderboard/me call (polled every 60s by the navbar for every logged-in student),
// so bounding it matters. 400 days comfortably covers any realistic active streak; an
// exceptionally long (over a year) unbroken streak would just be conservatively under-reported,
// never over-reported.
const CURRENT_STREAK_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000;

async function unionAcceptedActivityDayKeysIst(studentId) {
  const oid = new mongoose.Types.ObjectId(String(studentId));
  const since = new Date(Date.now() - CURRENT_STREAK_LOOKBACK_MS);
  const [arenaRows, assignmentRows] = await Promise.all([
    ArenaSubmission.find({ student_id: oid, status: ACCEPTED_STATUS, submitted_at: { $gte: since } })
      .select("submitted_at")
      .lean(),
    AssignmentSubmission.find({ student_id: oid, status: ACCEPTED_STATUS, submitted_at: { $gte: since } })
      .select("submitted_at")
      .lean(),
  ]);
  const daySet = new Set();
  for (const row of [...arenaRows, ...assignmentRows]) {
    if (!row.submitted_at) continue;
    daySet.add(toIndiaCalendarYmd(row.submitted_at));
  }
  return [...daySet].sort();
}

/** "Grace Days": every 14 active days banks one tolerated gap, capped at 3 — so one missed day
 * (an exam, a festival, a power cut) doesn't collapse weeks of a streak to zero. Stateless by
 * design: earned grace is a pure function of the active days already counted, not a persisted
 * ledger, so this stays a plain recompute like the rest of the streak logic. */
const GRACE_DAY_CAP = 3;
const GRACE_DAY_EARN_INTERVAL = 14;

/**
 * Current (live) IST streak ending today or yesterday, unlike the "best-ever" streak used for
 * badges. `todayYmd` is the caller's current IST calendar day. Tolerates gaps via Grace Days
 * (see above) instead of resetting to zero on the first missed day.
 */
function currentIstStreakFromSortedDays(sortedYmd, todayYmd) {
  const daySet = new Set(sortedYmd);
  let anchor = null;
  let activeToday = false;
  if (daySet.has(todayYmd)) {
    anchor = todayYmd;
    activeToday = true;
  } else {
    const yesterdayYmd = toIndiaCalendarYmd(new Date(istUtcMidnightMs(todayYmd) - 86400000));
    if (daySet.has(yesterdayYmd)) anchor = yesterdayYmd;
  }
  if (!anchor) return { current_streak: 0, active_today: false };

  let count = 0;
  let graceUsed = 0;
  let cursorMs = istUtcMidnightMs(anchor);
  for (;;) {
    if (daySet.has(toIndiaCalendarYmd(new Date(cursorMs)))) {
      count += 1;
      cursorMs -= 86400000;
      continue;
    }
    const graceEarned = Math.min(GRACE_DAY_CAP, Math.floor(count / GRACE_DAY_EARN_INTERVAL));
    if (graceUsed >= graceEarned) break;
    graceUsed += 1;
    cursorMs -= 86400000;
  }
  return { current_streak: count, active_today: activeToday };
}

/**
 * "Closed the Gap": awarded when a student's batch rank improves AND the specific student who was
 * directly above them last time we checked is no longer above them (a genuine overtake, not just
 * noise from someone else's activity). Compares against a small persisted snapshot
 * (StudentLeaderboardGapState) rather than full leaderboard history. Limited to once per
 * (overtaker, overtaken) pair per IST week via the award_period key, so camping next to a weak
 * target can't be farmed repeatedly in the same week.
 */
async function ensureGapOvertakeBadge(studentId) {
  const sid = String(studentId);
  if (!mongoose.Types.ObjectId.isValid(sid)) return false;
  const oid = new mongoose.Types.ObjectId(sid);

  const rawStudent = await Student.findById(sid).lean();
  if (!rawStudent) return false;
  const { board, ids } = await resolveDefaultBatchBoard(rawStudent);
  if (!board || ids.length < 2) return false;

  const merged = await buildRows("all_time", { batchIds: [board] });
  const sorted = ids
    .map((id) => String(id))
    .map((id) => [id, Number(merged.get(id)?.xp || 0)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const myIdx = sorted.findIndex(([id]) => id === sid);
  if (myIdx < 0) return false;
  const myRank = myIdx + 1;
  const aboveId = myIdx > 0 ? sorted[myIdx - 1][0] : null;

  const prior = await StudentLeaderboardGapState.findOne({ student_id: oid }).lean();
  const overtookId =
    prior &&
    prior.last_above_student_id &&
    typeof prior.last_rank === "number" &&
    myRank < prior.last_rank &&
    String(prior.last_above_student_id) !== String(aboveId || "")
      ? String(prior.last_above_student_id)
      : null;

  await StudentLeaderboardGapState.updateOne(
    { student_id: oid },
    {
      $set: {
        batch_id: board,
        last_above_student_id: aboveId ? new mongoose.Types.ObjectId(aboveId) : null,
        last_rank: myRank,
      },
    },
    { upsert: true }
  );

  if (!overtookId) return false;

  try {
    await StudentAchievementBadge.create({
      student_id: oid,
      badge_code: "closed_the_gap",
      category: "leaderboard_gap",
      title: "Closed the Gap",
      description: "Overtook a batchmate on the leaderboard.",
      threshold_value: 0,
      icon_key: "swords",
      accent: "orange",
      awarded_at: new Date(),
      award_period: `${indiaWeekKey(new Date())}:${overtookId}`,
    });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    throw err;
  }
}

/** "SIGSEGV (Recovered)": a one-off, one-per-account badge celebrating persistence rather than
 * speed — awarded the moment a student's FIRST-EVER accepted submission on a question follows 10+
 * prior non-accepted attempts on that same question. Checked only at the exact accept that could
 * trigger it (the controller already knows it just recorded an Accepted submission), not rescanned
 * on every future submission. */
const RECOVERED_BADGE_MIN_ATTEMPTS = 10;

async function ensureRecoveredBadgeGeneric(SubmissionModel, studentId, questionId) {
  const sid = String(studentId);
  const qidRaw = String(questionId || "");
  if (!mongoose.Types.ObjectId.isValid(sid) || !mongoose.Types.ObjectId.isValid(qidRaw)) return false;
  const oid = new mongoose.Types.ObjectId(sid);
  const qid = new mongoose.Types.ObjectId(qidRaw);

  const acceptedCount = await SubmissionModel.countDocuments({ student_id: oid, question_id: qid, status: ACCEPTED_STATUS });
  if (acceptedCount !== 1) return false; // not this student's first-ever accept on this question

  const priorAttempts = await SubmissionModel.countDocuments({
    student_id: oid,
    question_id: qid,
    status: { $not: ACCEPTED_STATUS },
  });
  if (priorAttempts < RECOVERED_BADGE_MIN_ATTEMPTS) return false;

  try {
    await StudentAchievementBadge.create({
      student_id: oid,
      badge_code: "sigsegv_recovered",
      category: "persistence",
      title: "SIGSEGV (Recovered)",
      description: "Cracked a problem after 10+ attempts instead of giving up.",
      threshold_value: RECOVERED_BADGE_MIN_ATTEMPTS,
      icon_key: "zap",
      accent: "emerald",
      awarded_at: new Date(),
      award_period: "",
    });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    throw err;
  }
}

async function ensureRecoveredBadgeForAssignment(studentId, questionId) {
  return ensureRecoveredBadgeGeneric(AssignmentSubmission, studentId, questionId);
}

async function ensureRecoveredBadgeForArena(studentId, questionId) {
  return ensureRecoveredBadgeGeneric(ArenaSubmission, studentId, questionId);
}

/**
 * Upsert badges the student qualifies for (idempotent; never downgrades/removes awards).
 */
async function ensureMilestoneBadges(studentId) {
  const sid = String(studentId);
  if (!mongoose.Types.ObjectId.isValid(sid)) return;
  const oid = new mongoose.Types.ObjectId(sid);

  const qIds = await batchArenaQuestionIdsForStudent(sid);
  const [questsSolved, bestStreak] = await Promise.all([
    countDistinctArenaQuestsSolved(sid, qIds),
    bestArenaAcceptedStreakDaysIst(sid, qIds),
  ]);

  const now = new Date();

  const upserts = [];
  for (const def of ARENA_QUEST_MILESTONES) {
    if (questsSolved < def.at) continue;
    const pres = await badgeDefSvc.getPublishedPresentation(def.code);
    upserts.push(
      StudentAchievementBadge.updateOne(
        { student_id: oid, badge_code: def.code },
        {
          $setOnInsert: {
            student_id: oid,
            badge_code: def.code,
            category: "arena_quests",
            title: pres.title,
            description: pres.description,
            threshold_value: def.at,
            icon_key: pres.icon_key,
            accent: pres.accent,
            awarded_at: now,
          },
        },
        { upsert: true }
      )
    );
  }

  for (const def of ARENA_STREAK_BEST_MILESTONES) {
    if (bestStreak < def.days) continue;
    const pres = await badgeDefSvc.getPublishedPresentation(def.code);
    upserts.push(
      StudentAchievementBadge.updateOne(
        { student_id: oid, badge_code: def.code },
        {
          $setOnInsert: {
            student_id: oid,
            badge_code: def.code,
            category: "arena_streak",
            title: pres.title,
            description: pres.description,
            threshold_value: def.days,
            icon_key: pres.icon_key,
            accent: pres.accent,
            awarded_at: now,
          },
        },
        { upsert: true }
      )
    );
  }

  if (upserts.length) await Promise.all(upserts);
}

async function listMilestoneBadgesForStudent(studentId) {
  return StudentAchievementBadge.find({ student_id: studentId }).sort({ awarded_at: -1 }).lean();
}

module.exports = {
  ensureMilestoneBadges,
  ensureGapOvertakeBadge,
  ensureRecoveredBadgeForAssignment,
  ensureRecoveredBadgeForArena,
  listMilestoneBadgesForStudent,
  batchArenaQuestionIdsForStudent,
  countDistinctArenaQuestsSolved,
  bestArenaAcceptedStreakDaysIst,
  unionAcceptedActivityDayKeysIst,
  currentIstStreakFromSortedDays,
};
