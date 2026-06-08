const mongoose = require("mongoose");
const Student = require("../models/Student");
const ArenaQuestion = require("../models/ArenaQuestion");
const ArenaSubmission = require("../models/ArenaSubmission");
const StudentAchievementBadge = require("../models/StudentAchievementBadge");
const { resolveStudentBatchIds } = require("../utils/student-batch-context");
const { toIndiaCalendarYmd } = require("../utils/india-time");
const { ARENA_QUEST_MILESTONES, ARENA_STREAK_BEST_MILESTONES } = require("../config/achievement-badges");
const badgeDefSvc = require("./achievement-badge-definition.service");

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
  listMilestoneBadgesForStudent,
  batchArenaQuestionIdsForStudent,
  countDistinctArenaQuestsSolved,
  bestArenaAcceptedStreakDaysIst,
};
