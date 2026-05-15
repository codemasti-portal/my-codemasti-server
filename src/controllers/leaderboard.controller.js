const mongoose = require("mongoose");
const { sendSuccess } = require("../utils/response");
const Student = require("../models/Student");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaSubmission = require("../models/ArenaSubmission");
const {
  augmentStudentCatalogFieldsFromEnrollment,
  catalogBatchMongoMatch,
} = require("../utils/enrollment");
const {
  indiaThisYearSubmittedMatch,
  indiaThisMonthSubmittedMatch,
  indiaThisWeekSubmittedMatch,
  submittedAtIndiaCalendarMonth,
} = require("../utils/india-time");

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBatchScopeFilter(studentDoc) {
  const keys = Array.from(
    new Set(
      [studentDoc?.batch_id, studentDoc?.batch, studentDoc?.enrollment_batch_name]
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    )
  );
  const or = [];
  for (const key of keys) {
    const rx = new RegExp(`^${escapeRegex(key)}$`, "i");
    or.push({ batch_id: rx }, { batch: rx }, { enrollment_batch_name: rx });
  }
  if (or.length === 0) return { _id: studentDoc?._id };
  return { $or: or };
}

async function getScopedStudentIdSet(studentId) {
  const rawStudent = await Student.findById(studentId).lean();
  const studentDoc = augmentStudentCatalogFieldsFromEnrollment(rawStudent);
  if (!studentDoc) return null;

  const batchId = String(studentDoc.batch_id || "").trim().toLowerCase();
  const filter = batchId
    ? { role: "student", ...catalogBatchMongoMatch(batchId) }
    : { role: "student", ...buildBatchScopeFilter(studentDoc) };
  const peerStudents = await Student.find(filter, { _id: 1 }).lean();
  return new Set(peerStudents.map((row) => String(row._id)));
}

function submittedAtMatch(timeFilter) {
  const now = new Date();
  if (timeFilter === "all_time") return {};
  if (timeFilter === "this_year") return indiaThisYearSubmittedMatch(now);
  if (timeFilter === "this_month") return indiaThisMonthSubmittedMatch(now);
  if (timeFilter === "this_week") return indiaThisWeekSubmittedMatch(now);
  return {};
}

async function buildRowsForSubmittedFilter(t) {
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

async function buildRows(timeFilter) {
  return buildRowsForSubmittedFilter(submittedAtMatch(timeFilter));
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

async function buildLatestSubmissionMap(timeFilter) {
  return buildLatestSubmissionMapForFilter(submittedAtMatch(timeFilter));
}

async function list(req, res) {
  const raw = String(req.query.time_filter || "all_time");
  const tf = ["all_time", "this_year", "this_month", "this_week"].includes(raw) ? raw : "all_time";
  const scopedStudentIds = await getScopedStudentIdSet(req.user.sub);
  if (!scopedStudentIds) {
    return sendSuccess(res, []);
  }

  const [merged, latestSubmissionMap] = await Promise.all([
    buildRows(tf),
    buildLatestSubmissionMap(tf),
  ]);
  const ids = [...scopedStudentIds].map((id) => new mongoose.Types.ObjectId(id));
  const students = ids.length ? await Student.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(students.map((s) => [String(s._id), s]));

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
  const tf = ["all_time", "this_year", "this_month", "this_week"].includes(raw) ? raw : "all_time";
  const scopedStudentIds = await getScopedStudentIdSet(req.user.sub);
  if (!scopedStudentIds) {
    return sendSuccess(res, {
      rank: null,
      xp: 0,
      time_filter: tf,
      latest_submission_time: null,
    });
  }

  const [merged, latestSubmissionMap] = await Promise.all([
    buildRows(tf),
    buildLatestSubmissionMap(tf),
  ]);
  const selfId = String(req.user.sub);
  const entry = merged.get(selfId);
  const myXp = entry?.xp ?? 0;
  const myLast = latestSubmissionMap.get(selfId) || entry?.last;

  const sorted = [...scopedStudentIds]
    .map((id) => [id, merged.get(id) || { xp: 0, last: new Date(0) }])
    .sort((a, b) => Number(b[1].xp || 0) - Number(a[1].xp || 0) || String(a[0]).localeCompare(String(b[0])));
  const rankIdx = sorted.findIndex(([id]) => id === selfId);

  return sendSuccess(res, {
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    xp: myXp,
    time_filter: tf,
    latest_submission_time: myLast && myLast > new Date(0) ? myLast.toISOString() : null,
  });
}

module.exports = {
  list,
  me,
  buildRowsForSubmittedFilter,
  submittedAtIndiaCalendarMonth,
  buildLatestSubmissionMapForFilter,
};
