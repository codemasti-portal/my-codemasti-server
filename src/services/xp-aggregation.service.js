const mongoose = require("mongoose");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaSubmission = require("../models/ArenaSubmission");
const {
  indiaThisYearSubmittedMatch,
  indiaThisMonthSubmittedMatch,
  indiaThisWeekSubmittedMatch,
  submittedAtIndiaCalendarMonth,
} = require("../utils/india-time");

/**
 * Shared XP computation used by both the leaderboard (cross-cohort ranking) and badge
 * eligibility checks (per-student threshold checks). Kept as its own service, not a
 * controller, so services never have to depend on a controller to compute XP.
 */

/** `month` is only read when timeFilter === "month", as "YYYY-MM" (e.g. picking a specific past
 * month from the leaderboard filter, distinct from the relative "this_month" bucket). */
function submittedAtMatch(timeFilter, month) {
  const now = new Date();
  if (timeFilter === "all_time") return {};
  if (timeFilter === "this_year") return indiaThisYearSubmittedMatch(now);
  if (timeFilter === "this_month") return indiaThisMonthSubmittedMatch(now);
  if (timeFilter === "this_week") return indiaThisWeekSubmittedMatch(now);
  if (timeFilter === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || "").trim());
    if (m) return submittedAtIndiaCalendarMonth(Number(m[1]), Number(m[2]));
  }
  return {};
}

async function buildRowsForSubmittedFilter(t, { batchIds } = {}) {
  // When batchIds is provided, XP is limited to that batch set's OWN content — arena questions /
  // assignments tagged to those batches, plus globally-visible untagged content (batch_id="" with no
  // batch_ids), which is shown to every batch. Omitted = global (all content): preserves legacy
  // leaderboards and lifetime/milestone badge programs byte-for-byte.
  const scopeKeys = Array.isArray(batchIds)
    ? [...new Set(batchIds.map((b) => String(b || "").toLowerCase().trim()).filter(Boolean))]
    : [];
  const scoped = scopeKeys.length > 0;
  // Normalize the looked-up doc's batch tags to lowercase, then keep only rows whose content belongs
  // to one of the scoped batches (or is global/untagged).
  const arenaBatchStages = scoped
    ? [
        {
          $addFields: {
            _bid: { $toLower: { $ifNull: ["$q.batch_id", ""] } },
            _bids: { $map: { input: { $ifNull: ["$q.batch_ids", []] }, as: "b", in: { $toLower: { $ifNull: ["$$b", ""] } } } },
          },
        },
        {
          $match: {
            $or: [
              { _bid: { $in: scopeKeys } },
              { _bids: { $in: scopeKeys } },
              { $and: [{ _bid: "" }, { _bids: { $size: 0 } }] },
            ],
          },
        },
      ]
    : [];
  const assignBatchStages = scoped
    ? [
        {
          $addFields: {
            _abid: { $toLower: { $ifNull: ["$a.batch_id", ""] } },
            _abids: { $map: { input: { $ifNull: ["$a.batch_ids", []] }, as: "b", in: { $toLower: { $ifNull: ["$$b", ""] } } } },
          },
        },
        {
          $match: {
            $or: [
              { _abid: { $in: scopeKeys } },
              { _abids: { $in: scopeKeys } },
              // global/untagged — but only for a real assignment (orphaned submissions are excluded).
              { $and: [{ "a._id": { $exists: true } }, { _abid: "" }, { _abids: { $size: 0 } }] },
            ],
          },
        },
      ]
    : [];
  const assignPipe = [
    { $match: { status: "Accepted", ...t } },
    {
      $lookup: {
        from: "assignmentquestions",
        localField: "question_id",
        foreignField: "_id",
        as: "q",
      },
    },
    { $unwind: "$q" },
    {
      $lookup: {
        from: "assignments",
        localField: "assignment_id",
        foreignField: "_id",
        as: "a",
      },
    },
    { $unwind: { path: "$a", preserveNullAndEmptyArrays: true } },
    ...assignBatchStages,
    {
      $addFields: {
        _fullXp: {
          $max: [{ $toInt: { $ifNull: ["$q.xp", 0] } }, 0],
        },
      },
    },
    {
      $group: {
        _id: { student_id: "$student_id", question_id: "$question_id" },
        best_xp: { $max: { $ifNull: ["$xp_awarded", 0] } },
        first_submitted_at: { $min: "$submitted_at" },
        full_xp: { $first: "$_fullXp" },
        deadline_date: { $first: "$a.deadline_date" },
        last: { $max: "$submitted_at" },
      },
    },
    {
      $addFields: {
        derived_xp: {
          $cond: [
            {
              $or: [
                { $eq: ["$deadline_date", null] },
                { $lte: ["$first_submitted_at", "$deadline_date"] },
              ],
            },
            "$full_xp",
            { $floor: { $divide: ["$full_xp", 2] } },
          ],
        },
      },
    },
    {
      $addFields: {
        effective_xp: {
          $cond: [{ $gt: ["$best_xp", 0] }, "$best_xp", "$derived_xp"],
        },
      },
    },
    {
      $group: {
        _id: "$_id.student_id",
        xp: { $sum: "$effective_xp" },
        last: { $max: "$last" },
      },
    },
  ];
  const arenaPipe = [
    { $match: { status: "Accepted", ...t } },
    {
      $group: {
        _id: { student_id: "$student_id", question_id: "$question_id" },
        credited: { $max: { $ifNull: ["$xp_credited", 0] } },
        first_submitted_at: { $min: "$submitted_at" },
      },
    },
    {
      $lookup: {
        from: "arenaquestions",
        localField: "_id.question_id",
        foreignField: "_id",
        as: "q",
      },
    },
    { $unwind: "$q" },
    ...arenaBatchStages,
    {
      $addFields: {
        effective_xp: {
          $cond: [
            { $gt: ["$credited", 0] },
            "$credited",
            { $max: [{ $toInt: { $ifNull: ["$q.xp", 0] } }, 0] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$_id.student_id",
        xp: { $sum: "$effective_xp" },
        last: { $max: "$first_submitted_at" },
      },
    },
  ];

  const [assignRows, arenaRows] = await Promise.all([
    AssignmentSubmission.aggregate(assignPipe),
    ArenaSubmission.aggregate(arenaPipe),
  ]);

  const merged = new Map();
  for (const row of assignRows) {
    merged.set(String(row._id), {
      xp: row.xp,
      last: row.last ? new Date(row.last) : new Date(0),
    });
  }
  for (const row of arenaRows) {
    const id = String(row._id);
    const prev = merged.get(id) || { xp: 0, last: new Date(0) };
    const last = row.last ? new Date(row.last) : new Date(0);
    merged.set(id, {
      xp: prev.xp + row.xp,
      last: last > prev.last ? last : prev.last,
    });
  }
  return merged;
}

async function buildRows(timeFilter, opts, month) {
  return buildRowsForSubmittedFilter(submittedAtMatch(timeFilter, month), opts);
}

async function buildLatestSubmissionMapForFilter(t) {
  const [assignmentLatest, arenaLatest] = await Promise.all([
    AssignmentSubmission.aggregate([
      { $match: { status: "Accepted", ...t } },
      { $group: { _id: "$student_id", last: { $max: "$submitted_at" } } },
    ]),
    ArenaSubmission.aggregate([
      { $match: t },
      { $group: { _id: "$student_id", last: { $max: "$submitted_at" } } },
    ]),
  ]);

  const latestMap = new Map();
  for (const row of assignmentLatest) {
    latestMap.set(String(row._id), row.last ? new Date(row.last) : new Date(0));
  }
  for (const row of arenaLatest) {
    const id = String(row._id);
    const prev = latestMap.get(id) || new Date(0);
    const current = row.last ? new Date(row.last) : new Date(0);
    latestMap.set(id, current > prev ? current : prev);
  }
  return latestMap;
}

async function buildLatestSubmissionMap(timeFilter, month) {
  return buildLatestSubmissionMapForFilter(submittedAtMatch(timeFilter, month));
}

/**
 * Single-student XP for a period — used by badge-eligibility checks, which only ever need one
 * student's number. Unlike buildRowsForSubmittedFilter (which aggregates every student in scope
 * to produce a ranked board), this never touches other students' submissions, so it's cheap
 * enough to call directly on every accepted submission with no cache needed.
 */
async function computeStudentXpForPeriod(studentId, t, { batchIds } = {}) {
  const oid = new mongoose.Types.ObjectId(String(studentId));
  const scopeKeys = Array.isArray(batchIds)
    ? [...new Set(batchIds.map((b) => String(b || "").toLowerCase().trim()).filter(Boolean))]
    : [];
  const scoped = scopeKeys.length > 0;

  const arenaBatchStages = scoped
    ? [
        {
          $addFields: {
            _bid: { $toLower: { $ifNull: ["$q.batch_id", ""] } },
            _bids: { $map: { input: { $ifNull: ["$q.batch_ids", []] }, as: "b", in: { $toLower: { $ifNull: ["$$b", ""] } } } },
          },
        },
        {
          $match: {
            $or: [
              { _bid: { $in: scopeKeys } },
              { _bids: { $in: scopeKeys } },
              { $and: [{ _bid: "" }, { _bids: { $size: 0 } }] },
            ],
          },
        },
      ]
    : [];
  const assignBatchStages = scoped
    ? [
        {
          $addFields: {
            _abid: { $toLower: { $ifNull: ["$a.batch_id", ""] } },
            _abids: { $map: { input: { $ifNull: ["$a.batch_ids", []] }, as: "b", in: { $toLower: { $ifNull: ["$$b", ""] } } } },
          },
        },
        {
          $match: {
            $or: [
              { _abid: { $in: scopeKeys } },
              { _abids: { $in: scopeKeys } },
              { $and: [{ "a._id": { $exists: true } }, { _abid: "" }, { _abids: { $size: 0 } }] },
            ],
          },
        },
      ]
    : [];

  const assignPipe = [
    { $match: { student_id: oid, status: "Accepted", ...t } },
    { $lookup: { from: "assignmentquestions", localField: "question_id", foreignField: "_id", as: "q" } },
    { $unwind: "$q" },
    { $lookup: { from: "assignments", localField: "assignment_id", foreignField: "_id", as: "a" } },
    { $unwind: { path: "$a", preserveNullAndEmptyArrays: true } },
    ...assignBatchStages,
    { $addFields: { _fullXp: { $max: [{ $toInt: { $ifNull: ["$q.xp", 0] } }, 0] } } },
    {
      $group: {
        _id: "$question_id",
        best_xp: { $max: { $ifNull: ["$xp_awarded", 0] } },
        first_submitted_at: { $min: "$submitted_at" },
        full_xp: { $first: "$_fullXp" },
        deadline_date: { $first: "$a.deadline_date" },
      },
    },
    {
      $addFields: {
        derived_xp: {
          $cond: [
            { $or: [{ $eq: ["$deadline_date", null] }, { $lte: ["$first_submitted_at", "$deadline_date"] }] },
            "$full_xp",
            { $floor: { $divide: ["$full_xp", 2] } },
          ],
        },
      },
    },
    { $addFields: { effective_xp: { $cond: [{ $gt: ["$best_xp", 0] }, "$best_xp", "$derived_xp"] } } },
    { $group: { _id: null, xp: { $sum: "$effective_xp" } } },
  ];

  const arenaPipe = [
    { $match: { student_id: oid, status: "Accepted", ...t } },
    {
      $group: {
        _id: "$question_id",
        credited: { $max: { $ifNull: ["$xp_credited", 0] } },
      },
    },
    { $lookup: { from: "arenaquestions", localField: "_id", foreignField: "_id", as: "q" } },
    { $unwind: "$q" },
    ...arenaBatchStages,
    {
      $addFields: {
        effective_xp: { $cond: [{ $gt: ["$credited", 0] }, "$credited", { $max: [{ $toInt: { $ifNull: ["$q.xp", 0] } }, 0] }] },
      },
    },
    { $group: { _id: null, xp: { $sum: "$effective_xp" } } },
  ];

  const [assignAgg, arenaAgg] = await Promise.all([
    AssignmentSubmission.aggregate(assignPipe),
    ArenaSubmission.aggregate(arenaPipe),
  ]);
  const assignXp = Number(assignAgg[0]?.xp || 0);
  const arenaXp = Number(arenaAgg[0]?.xp || 0);
  return assignXp + arenaXp;
}

module.exports = {
  submittedAtMatch,
  buildRowsForSubmittedFilter,
  buildRows,
  buildLatestSubmissionMapForFilter,
  buildLatestSubmissionMap,
  computeStudentXpForPeriod,
};
