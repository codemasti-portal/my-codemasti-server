const mongoose = require("mongoose");
const { sendSuccess } = require("../utils/response");
const Student = require("../models/Student");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaSubmission = require("../models/ArenaSubmission");

function buildBatchScopeFilter(studentDoc) {
  const or = [];
  if (studentDoc?.batch_id) or.push({ batch_id: String(studentDoc.batch_id) });
  if (studentDoc?.batch) or.push({ batch: String(studentDoc.batch) });
  if (studentDoc?.enrollment_batch_name) {
    or.push({ enrollment_batch_name: String(studentDoc.enrollment_batch_name) });
  }
  if (or.length === 0) return { _id: studentDoc?._id };
  return { $or: or };
}

async function getScopedStudentIdSet(studentId) {
  const studentDoc = await Student.findById(studentId).lean();
  if (!studentDoc) return null;

  const filter = buildBatchScopeFilter(studentDoc);
  const peerStudents = await Student.find(filter, { _id: 1 }).lean();
  return new Set(peerStudents.map((row) => String(row._id)));
}

function submittedAtMatch(timeFilter) {
  if (timeFilter === "all_time") return {};
  if (timeFilter === "this_year") {
    const s = new Date();
    s.setUTCMonth(0, 1);
    s.setUTCHours(0, 0, 0, 0);
    return { submitted_at: { $gte: s } };
  }
  if (timeFilter === "this_month") {
    const s = new Date();
    s.setUTCDate(1);
    s.setUTCHours(0, 0, 0, 0);
    return { submitted_at: { $gte: s } };
  }
  if (timeFilter === "this_week") {
    const s = new Date();
    const day = s.getUTCDay();
    const diff = (day + 6) % 7;
    s.setUTCDate(s.getUTCDate() - diff);
    s.setUTCHours(0, 0, 0, 0);
    return { submitted_at: { $gte: s } };
  }
  return {};
}

async function buildRows(timeFilter) {
  const t = submittedAtMatch(timeFilter);

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
      $addFields: {
        _assignXp: {
          $ifNull: ["$xp_awarded", "$q.xp"],
        },
      },
    },
    { $group: { _id: "$student_id", xp: { $sum: "$_assignXp" }, last: { $max: "$submitted_at" } } },
  ];
  const arenaPipe = [
    { $match: { status: "Accepted", ...t } },
    {
      $lookup: {
        from: "arenaquestions",
        localField: "question_id",
        foreignField: "_id",
        as: "q",
      },
    },
    { $unwind: "$q" },
    { $group: { _id: "$student_id", xp: { $sum: "$q.xp" }, last: { $max: "$submitted_at" } } },
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

async function buildLatestSubmissionMap(timeFilter) {
  const t = submittedAtMatch(timeFilter);
  const [assignmentLatest, arenaLatest] = await Promise.all([
    AssignmentSubmission.aggregate([
      { $match: t },
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
  const ids = [...merged.keys()]
    .filter((id) => scopedStudentIds.has(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const students = ids.length ? await Student.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(students.map((s) => [String(s._id), s]));

  const rows = ids
    .map((oid) => String(oid))
    .map((id) => {
      const s = byId.get(id);
      const v = merged.get(id);
      if (!s || !v) return null;
      return {
        id,
        name: s.name,
        avatar_url: s.avatar_url || "",
        xp: v.xp,
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
  const raw = String(req.query.time_filter || "this_month");
  const tf = ["all_time", "this_year", "this_month", "this_week"].includes(raw) ? raw : "this_month";
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

  const sorted = [...merged.entries()]
    .filter(([id]) => scopedStudentIds.has(id))
    .sort((a, b) => b[1].xp - a[1].xp);
  const rankIdx = sorted.findIndex(([id]) => id === selfId);

  return sendSuccess(res, {
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    xp: myXp,
    time_filter: tf,
    latest_submission_time: myLast && myLast > new Date(0) ? myLast.toISOString() : null,
  });
}

module.exports = { list, me };
