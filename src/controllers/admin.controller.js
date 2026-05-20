const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const Assignment = require("../models/Assignment");
const AssignmentQuestion = require("../models/AssignmentQuestion");
const AssignmentSubmission = require("../models/AssignmentSubmission");
const ArenaSubmission = require("../models/ArenaSubmission");
const ArenaQuestion = require("../models/ArenaQuestion");
const ReferralEvent = require("../models/ReferralEvent");
const referralRewards = require("../utils/referralRewards");
const { notifyReferralAdmissionSuccess } = require("../services/referralNotifications.service");
const {
  parseEnrollmentNumber,
  deriveStudentBatchFromEnrollment,
  catalogBatchMongoMatch,
  augmentStudentCatalogFieldsFromEnrollment,
  applyEnrollmentDerivedFieldsToStudentDocument,
  studentsInCatalogBatchesFilter,
} = require("../utils/enrollment");
const {
  assignmentPublishedVisibleToCatalogBatch,
  assignmentDocMatchesCatalogBatch,
  assignmentDocIsPublished,
} = require("../utils/assignmentBatchFilter");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildStudentAvatarFolder,
} = require("../utils/cloudinary");
const { getUploadsRoot } = require("../utils/upload-paths");
const { getInstructorAssignedBatchIds, studentInAnyAssignedBatch } = require("../utils/instructorBatchScope");

const uploadsRoot = getUploadsRoot();
const avatarsDir = path.join(uploadsRoot, "avatars");

/** Arena catalog visible to a student's batch (aligned with student arena list). */
function arenaStudentCatalogFilter(batchKey) {
  const batchId = String(batchKey || "").trim().toLowerCase();
  if (!batchId) return null;
  return {
    $and: [
      {
        $or: [{ batch_id: batchId }, { batch_ids: { $in: [batchId] } }],
      },
      { $or: [{ is_disabled: false }, { is_disabled: { $exists: false } }] },
    ],
  };
}

async function arenaProgressForStudentId(studentId, batchKey) {
  const filter = arenaStudentCatalogFilter(batchKey);
  if (!filter) {
    return { arena_questions_total: 0, arena_solved_count: 0 };
  }
  const qs = await ArenaQuestion.find(filter).select("_id").lean();
  const qIds = qs.map((q) => q._id);
  const total = qIds.length;
  if (!total) {
    return { arena_questions_total: 0, arena_solved_count: 0 };
  }
  const solvedDistinct = await ArenaSubmission.distinct("question_id", {
    student_id: studentId,
    status: "Accepted",
    question_id: { $in: qIds },
  });
  return {
    arena_questions_total: total,
    arena_solved_count: solvedDistinct.length,
  };
}

async function arenaQuestionsForAdminBatchKeys(batchKeys) {
  const keys = [...new Set(batchKeys.map((k) => String(k || "").trim().toLowerCase()).filter(Boolean))];
  if (!keys.length) return [];
  return ArenaQuestion.find({
    $and: [
      {
        $or: [{ batch_id: { $in: keys } }, { batch_ids: { $in: keys } }],
      },
      { $or: [{ is_disabled: false }, { is_disabled: { $exists: false } }] },
    ],
  })
    .select("_id batch_id batch_ids is_disabled")
    .lean();
}

function arenaQuestionIdsForStudentBatch(batchKey, questions) {
  const b = String(batchKey || "").trim().toLowerCase();
  if (!b) return [];
  return questions
    .filter((q) => {
      if (q.is_disabled === true) return false;
      const bid = String(q.batch_id || "").trim().toLowerCase();
      if (bid === b) return true;
      const arr = Array.isArray(q.batch_ids) ? q.batch_ids : [];
      return arr.some((x) => String(x || "").trim().toLowerCase() === b);
    })
    .map((q) => q._id);
}

/**
 * Per-student arena solved counts (distinct accepted questions in their batch catalog).
 */
async function arenaProgressMapsForStudentRows(studentRows) {
  const solvedMap = new Map();
  const totalMap = new Map();

  const byBatch = new Map();
  for (const s of studentRows) {
    const enriched = augmentStudentCatalogFieldsFromEnrollment(s);
    const sid = String(enriched._id);
    const bk = String(enriched.batch_id || enriched.batch || "").trim().toLowerCase();
    if (!bk) {
      solvedMap.set(sid, 0);
      totalMap.set(sid, 0);
      continue;
    }
    if (!byBatch.has(bk)) byBatch.set(bk, []);
    byBatch.get(bk).push({ sid, oid: enriched._id });
  }

  const batchKeys = [...byBatch.keys()];
  const allQs = await arenaQuestionsForAdminBatchKeys(batchKeys);

  for (const [bk, pairs] of byBatch.entries()) {
    const qIds = arenaQuestionIdsForStudentBatch(bk, allQs);
    const total = qIds.length;
    for (const { sid } of pairs) {
      totalMap.set(sid, total);
    }
    if (!pairs.length || !qIds.length) {
      for (const { sid } of pairs) solvedMap.set(sid, 0);
      continue;
    }
    const studObjectIds = pairs.map((p) => p.oid);
    const agg = await ArenaSubmission.aggregate([
      {
        $match: {
          student_id: { $in: studObjectIds },
          status: "Accepted",
          question_id: { $in: qIds },
        },
      },
      { $group: { _id: { sid: "$student_id", qid: "$question_id" } } },
      { $group: { _id: "$_id.sid", n: { $sum: 1 } } },
    ]);
    const counts = new Map();
    for (const r of agg) {
      const raw = r._id;
      const key = raw != null && typeof raw.toString === "function" ? raw.toString() : String(raw);
      counts.set(key, Number(r.n || 0));
    }
    for (const { sid } of pairs) {
      const key = String(sid);
      solvedMap.set(key, counts.get(key) ?? 0);
    }
  }

  return { solvedMap, totalMap };
}

const ASSIGNMENT_PROGRESS_ALL_BATCHES_KEY = "__cm_all_batches__";

function mongoEntityKey(id) {
  if (id == null) return "";
  return typeof id.toString === "function" ? id.toString() : String(id);
}

/**
 * Per student: assignments fully solved (every question has an Accepted submission) /
 * total published assignments that have at least one question for their batch.
 */
async function assignmentProgressMapsForStudentRows(studentRows, now = new Date()) {
  const solvedMap = new Map();
  const totalMap = new Map();
  const byBatch = new Map();

  for (const s of studentRows) {
    const enriched = augmentStudentCatalogFieldsFromEnrollment(s);
    const sid = mongoEntityKey(enriched._id);
    const bk = String(enriched.batch_id || enriched.batch || "").trim().toLowerCase();
    const groupKey = bk || ASSIGNMENT_PROGRESS_ALL_BATCHES_KEY;
    if (!byBatch.has(groupKey)) byBatch.set(groupKey, []);
    byBatch.get(groupKey).push({ sid, oid: enriched._id });
  }

  for (const [bk, pairs] of byBatch.entries()) {
    const filter =
      bk === ASSIGNMENT_PROGRESS_ALL_BATCHES_KEY
        ? assignmentPublishedVisibleToCatalogBatch("", now)
        : assignmentPublishedVisibleToCatalogBatch(bk, now);
    const assignmentsFromQuery = await Assignment.find(filter).select("_id batch_id batch_ids release_date").lean();

    const idSet = new Set(assignmentsFromQuery.map((a) => String(a._id)));
    const studObjectIds = pairs.map((p) => p.oid);
    const acceptedSubs =
      studObjectIds.length > 0
        ? await AssignmentSubmission.find({
            student_id: { $in: studObjectIds },
            status: "Accepted",
          })
            .select("question_id")
            .lean()
        : [];
    const qidsFromSubs = [...new Set(acceptedSubs.map((r) => r.question_id).filter(Boolean))];
    if (qidsFromSubs.length > 0) {
      const qMeta = await AssignmentQuestion.find({ _id: { $in: qidsFromSubs } })
        .select("assignment_id")
        .lean();
      for (const q of qMeta) {
        if (q.assignment_id != null) idSet.add(String(q.assignment_id));
      }
    }

    const mergedIdList = [...idSet];
    const batchKeyForJs = bk === ASSIGNMENT_PROGRESS_ALL_BATCHES_KEY ? "" : bk;
    let aidList = [];
    if (mergedIdList.length > 0) {
      const mergedDocs = await Assignment.find({ _id: { $in: mergedIdList } })
        .select("_id batch_id batch_ids release_date")
        .lean();
      aidList = mergedDocs
        .filter((a) => assignmentDocIsPublished(a, now) && assignmentDocMatchesCatalogBatch(a, batchKeyForJs))
        .map((a) => a._id);
    }
    if (!aidList.length) {
      for (const { sid } of pairs) {
        solvedMap.set(sid, 0);
        totalMap.set(sid, 0);
      }
      continue;
    }

    const questions = await AssignmentQuestion.find({ assignment_id: { $in: aidList } })
      .select("_id assignment_id")
      .lean();

    const qsByAssignment = new Map();
    for (const q of questions) {
      const aid = String(q.assignment_id);
      if (!qsByAssignment.has(aid)) qsByAssignment.set(aid, []);
      qsByAssignment.get(aid).push(String(q._id));
    }

    const assignmentIdsWithQs = [...qsByAssignment.entries()]
      .filter(([, qids]) => qids.length > 0)
      .map(([aid]) => aid);
    const totalAssignments = assignmentIdsWithQs.length;

    const allQids = questions.map((q) => q._id);

    const accepted =
      allQids.length && studObjectIds.length
        ? await AssignmentSubmission.find({
            student_id: { $in: studObjectIds },
            status: "Accepted",
            question_id: { $in: allQids },
          })
            .select("student_id question_id")
            .lean()
        : [];

    const solvedQsByStudent = new Map();
    for (const row of accepted) {
      const st = mongoEntityKey(row.student_id);
      const qid = String(row.question_id);
      if (!solvedQsByStudent.has(st)) solvedQsByStudent.set(st, new Set());
      solvedQsByStudent.get(st).add(qid);
    }

    for (const { sid, oid } of pairs) {
      totalMap.set(sid, totalAssignments);
      const stKey = mongoEntityKey(oid);
      const solvedSet = solvedQsByStudent.get(stKey) || new Set();
      let solvedAssignmentCount = 0;
      for (const aid of assignmentIdsWithQs) {
        const qids = qsByAssignment.get(aid) || [];
        if (qids.length && qids.every((qid) => solvedSet.has(qid))) {
          solvedAssignmentCount += 1;
        }
      }
      solvedMap.set(sid, solvedAssignmentCount);
    }
  }

  return { solvedMap, totalMap };
}

async function assignmentProgressForStudentId(studentId, batchKey, now = new Date()) {
  const maps = await assignmentProgressMapsForStudentRows(
    [{ _id: studentId, batch_id: batchKey, batch: batchKey }],
    now
  );
  const sid = mongoEntityKey(studentId);
  return {
    assignments_solved_count: maps.solvedMap.get(sid) ?? 0,
    assignments_total_count: maps.totalMap.get(sid) ?? 0,
  };
}

async function createStudent(req, res) {
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(2).trim(),
    parent_name: z.string().min(2).trim(),
    phone_number: z.string().min(6).trim(),
    enrollment_number: z
      .string()
      .regex(/^[ISBisb]\d{6}$/, "enrollment_number must be I|S|B + 6 digits (e.g. I260105)"),
    enrollment_date: z.coerce.date(),
    school_class: z.number().int().min(5).max(10).optional(),
    school_name: z.string().min(1).max(200).trim(),
    student_phone: z.string().max(30).trim().optional().default(""),
    whatsapp_number: z.string().min(6).max(30).trim(),
    cst_registration_id: z.string().min(1).max(80).trim(),
    /** Optional existing student’s referral code (e.g. CM-abc12def). */
    referral_code: z.string().trim().optional(),
  });

  const body = schema.parse(req.body);

  let referredById = null;
  let registrationFeeDiscount = 0;
  const refInput = body.referral_code?.trim();
  if (refInput) {
    const referrer = await Student.findOne({
      role: "student",
      referral_code: new RegExp(`^${referralRewards.escapeRegex(refInput)}$`, "i"),
    }).lean();
    if (!referrer) {
      return sendError(res, 400, "INVALID_REFERRAL_CODE", "No student found with this referral code");
    }
    referredById = referrer._id;
    registrationFeeDiscount = referralRewards.REFEREE_REGISTRATION_DISCOUNT_PERCENT;
  }
  let enrollmentParsed;
  try {
    enrollmentParsed = parseEnrollmentNumber(body.enrollment_number);
  } catch (e) {
    return sendError(res, 400, "INVALID_ENROLLMENT_NUMBER", e.message || "Invalid enrollment number");
  }

  const [byEmail, byEnrollment] = await Promise.all([
    Student.findOne({ email: body.email }).lean(),
    Student.findOne({ enrollment_number: enrollmentParsed.enrollment_number }).lean(),
  ]);

  if (byEmail) return sendError(res, 409, "EMAIL_ALREADY_EXISTS", "Email already registered");
  if (byEnrollment) return sendError(res, 409, "ENROLLMENT_ALREADY_EXISTS", "Enrollment number already registered");

  const { batch, batch_id } = deriveStudentBatchFromEnrollment(enrollmentParsed);

  const created = await Student.create({
    email: body.email,
    name: body.name,
    role: "student",
    parent_name: body.parent_name,
    phone_number: body.phone_number,
    enrollment_number: enrollmentParsed.enrollment_number,
    enrollment_batch_prefix: enrollmentParsed.enrollment_batch_prefix,
    enrollment_batch_name: enrollmentParsed.enrollment_batch_name,
    enrollment_year: enrollmentParsed.enrollment_year,
    enrollment_section: enrollmentParsed.enrollment_section,
    section_id: enrollmentParsed.enrollment_section,
    enrollment_roll_no: enrollmentParsed.enrollment_roll_no,
    batch,
    batch_id,
    batch_allowance: "",
    course: "",
    progress: 0,
    enrollment_date: body.enrollment_date,
    school_class: body.school_class ?? null,
    school_name: body.school_name?.trim() ?? "",
    student_phone: body.student_phone?.trim() ?? "",
    whatsapp_number: body.whatsapp_number?.trim() ?? "",
    cst_registration_id: body.cst_registration_id?.trim() ?? "",
    referred_by: referredById,
    registration_fee_discount_percent: registrationFeeDiscount,
  });

  if (referredById) {
    const newCount = await Student.countDocuments({ referred_by: referredById });
    const referrerDoc = await Student.findById(referredById);
    if (referrerDoc) {
      if (!referrerDoc.referral_code) {
        referrerDoc.referral_code = `CM-${crypto.randomBytes(4).toString("hex")}`;
      }
      const entries = referralRewards.buildQueueEntries(created._id, newCount);
      referrerDoc.referral_benefits_queue = [...(referrerDoc.referral_benefits_queue || []), ...entries];
      await referrerDoc.save();
      await ReferralEvent.create({
        student_id: referredById,
        event: "referral_admission",
        meta: {
          new_student_id: String(created._id),
          new_total_referrals: newCount,
          benefits_queued: entries.length,
        },
      });
      await ReferralEvent.create({
        student_id: created._id,
        event: "joined_with_referral",
        meta: {
          referrer_id: String(referredById),
          registration_discount_percent: registrationFeeDiscount,
        },
      });

      void notifyReferralAdmissionSuccess({
        referrerId: referredById,
        newStudentId: created._id,
        newStudentName: created.name,
        referrerDisplayName: referrerDoc.name,
        newCount,
        queueEntries: entries,
      });
    }
  }

  const out = augmentStudentCatalogFieldsFromEnrollment(created.toObject ? created.toObject() : created);
  return sendSuccess(
    res,
    {
      id: String(out._id),
      email: out.email,
      name: out.name,
      batch: out.batch,
      batch_id: out.batch_id,
      enrollment_number: out.enrollment_number,
      enrollment_batch_prefix: out.enrollment_batch_prefix,
      enrollment_batch_name: out.enrollment_batch_name,
      enrollment_year: out.enrollment_year,
      enrollment_section: out.enrollment_section,
      enrollment_roll_no: out.enrollment_roll_no,
      school_class: out.school_class ?? null,
      avatar_url: out.avatar_url || "",
      registration_fee_discount_percent: out.registration_fee_discount_percent ?? 0,
      referral_applied: Boolean(referredById),
    },
    "Student created"
  );
}

async function listStudents(req, res) {
  const schema = z.object({
    batch_id: z.string().optional(),
    batch: z.string().optional(),
    q: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  const query = schema.parse(req.query);

  const pageNum = query.page || 1;
  const limitNum = query.limit || 50;

  const andParts = [];
  const batchKey = query.batch_id
    ? String(query.batch_id).trim().toLowerCase()
    : query.batch
      ? String(query.batch).trim().toLowerCase()
      : "";
  if (batchKey) {
    andParts.push(catalogBatchMongoMatch(batchKey));
  }
  if (query.q?.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    andParts.push({ $or: [{ name: rx }, { email: rx }] });
  }

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null) {
    if (!instructorBatches.length) {
      return sendSuccess(res, [], "", { page: pageNum, limit: limitNum, total: 0 });
    }
    if (batchKey) {
      if (!instructorBatches.includes(batchKey)) {
        return sendSuccess(res, [], "", { page: pageNum, limit: limitNum, total: 0 });
      }
    }
    const scoped = studentsInCatalogBatchesFilter(instructorBatches);
    andParts.push({ $or: scoped.$or });
  }

  const filter = { role: "student" };
  if (andParts.length === 1) {
    Object.assign(filter, andParts[0]);
  } else if (andParts.length > 1) {
    filter.$and = andParts;
  }

  const page = pageNum;
  const limit = limitNum;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Student.find(filter)
      .select(
        "name email batch batch_id course progress enrollment_date enrollment_number enrollment_batch_prefix enrollment_batch_name enrollment_year enrollment_section section_id enrollment_roll_no parent_name phone_number student_phone whatsapp_number school_name cst_registration_id batch_allowance school_class avatar_url referral_code referred_by registration_fee_discount_percent referral_bonus_count referral_benefits_queue last_login_at last_login_ip last_login_user_agent"
      )
      .sort({ enrollment_number: 1, name: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Student.countDocuments(filter),
  ]);

  const pageBatchKeys = Array.from(
    new Set(
      items
        .map((s) => String(s.batch_id || s.batch || "").trim())
        .filter(Boolean)
    )
  );

  let totalXpByStudent = new Map();
  let batchRankByStudent = new Map();
  if (pageBatchKeys.length > 0) {
    const batchOr = pageBatchKeys.map((key) => ({
      $or: [{ batch_id: key }, { batch: key }],
    }));
    const peers = await Student.find({ role: "student", $or: batchOr })
      .select("_id name batch batch_id")
      .lean();
    const peerIds = peers.map((p) => p._id);
    const peerIdStrings = new Set(peers.map((p) => String(p._id)));

    const [assignmentXpRows, arenaXpRows] = await Promise.all([
      AssignmentSubmission.aggregate([
        {
          $match: {
            student_id: { $in: peerIds },
            status: "Accepted",
          },
        },
        {
          $lookup: {
            from: "assignmentquestions",
            localField: "question_id",
            foreignField: "_id",
            as: "q",
          },
        },
        { $unwind: { path: "$q", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { student_id: "$student_id", question_id: "$question_id" },
            best_xp_awarded: { $max: { $ifNull: ["$xp_awarded", 0] } },
            full_xp: { $max: { $ifNull: ["$q.xp", 0] } },
          },
        },
        {
          $addFields: {
            effective_xp: {
              $cond: [{ $gt: ["$best_xp_awarded", 0] }, "$best_xp_awarded", "$full_xp"],
            },
          },
        },
        { $group: { _id: "$_id.student_id", xp: { $sum: "$effective_xp" } } },
      ]),
      ArenaSubmission.aggregate([
        {
          $match: {
            student_id: { $in: peerIds },
            status: "Accepted",
          },
        },
        {
          $group: {
            _id: { student_id: "$student_id", question_id: "$question_id" },
            credited: { $max: { $ifNull: ["$xp_credited", 0] } },
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
        { $group: { _id: "$_id.student_id", xp: { $sum: "$effective_xp" } } },
      ]),
    ]);

    totalXpByStudent = new Map();
    for (const row of assignmentXpRows) {
      totalXpByStudent.set(String(row._id), Math.max(0, Number(row.xp || 0)));
    }
    for (const row of arenaXpRows) {
      const id = String(row._id);
      totalXpByStudent.set(id, Math.max(0, Number(totalXpByStudent.get(id) || 0)) + Math.max(0, Number(row.xp || 0)));
    }

    const peersByBatch = new Map();
    for (const peer of peers) {
      const key = String(peer.batch_id || peer.batch || "").trim();
      if (!key) continue;
      if (!peersByBatch.has(key)) peersByBatch.set(key, []);
      peersByBatch.get(key).push(peer);
    }

    batchRankByStudent = new Map();
    for (const [, group] of peersByBatch) {
      const sorted = [...group]
        .filter((p) => peerIdStrings.has(String(p._id)))
        .sort((a, b) => {
          const axp = Number(totalXpByStudent.get(String(a._id)) || 0);
          const bxp = Number(totalXpByStudent.get(String(b._id)) || 0);
          if (bxp !== axp) return bxp - axp;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });
      sorted.forEach((peer, idx) => {
        batchRankByStudent.set(String(peer._id), idx + 1);
      });
    }
  }

  const referrerIds = items.map((s) => s._id).filter(Boolean);
  let verifiedByReferrer = new Map();
  if (referrerIds.length) {
    const agg = await Student.aggregate([
      { $match: { role: "student", referred_by: { $in: referrerIds } } },
      { $group: { _id: "$referred_by", c: { $sum: 1 } } },
    ]);
    verifiedByReferrer = new Map(agg.map((row) => [String(row._id), row.c]));
  }

  let arenaSolvedMap = new Map();
  let arenaTotalMap = new Map();
  if (items.length) {
    const maps = await arenaProgressMapsForStudentRows(items);
    arenaSolvedMap = maps.solvedMap;
    arenaTotalMap = maps.totalMap;
  }

  let assignmentSolvedMap = new Map();
  let assignmentTotalMap = new Map();
  if (items.length) {
    const am = await assignmentProgressMapsForStudentRows(items, new Date());
    assignmentSolvedMap = am.solvedMap;
    assignmentTotalMap = am.totalMap;
  }

  const data = items.map((s) => {
    const base = studentResponse(s);
    const verified = verifiedByReferrer.get(String(s._id)) || 0;
    const bonus = base.referral_bonus_count ?? 0;
    const sid = mongoEntityKey(s._id);
    const arenaSolved = arenaSolvedMap.get(sid) ?? arenaSolvedMap.get(String(base.id)) ?? 0;
    const arenaTotal = arenaTotalMap.get(sid) ?? arenaTotalMap.get(String(base.id)) ?? 0;
    const assignSolved = assignmentSolvedMap.get(sid) ?? assignmentSolvedMap.get(String(base.id)) ?? 0;
    const assignTotal = assignmentTotalMap.get(sid) ?? assignmentTotalMap.get(String(base.id)) ?? 0;
    return {
      ...base,
      referrals_made_count: verified,
      referrals_total: verified + bonus,
      total_xp: Math.max(0, Number(totalXpByStudent.get(sid) || 0)),
      batch_rank: Number(batchRankByStudent.get(sid) || 0) || null,
      arena_solved_count: arenaSolved,
      arena_questions_total: arenaTotal,
      /** Alias for clients that expect camelCase */
      arenaSolvedCount: arenaSolved,
      arenaQuestionsTotal: arenaTotal,
      assignments_solved_count: assignSolved,
      assignments_total_count: assignTotal,
      assignmentsSolvedCount: assignSolved,
      assignmentsTotalCount: assignTotal,
    };
  });
  return sendSuccess(res, data, "", { page, limit, total });
}

function referredBySummary(d) {
  const raw = d.referred_by;
  if (!raw) return { referred_by_id: "", referred_by_name: "", referred_by_enrollment: "" };
  if (typeof raw === "object" && raw !== null) {
    return {
      referred_by_id: String(raw._id || ""),
      referred_by_name: raw.name || "",
      referred_by_enrollment: raw.enrollment_number || "",
    };
  }
  return { referred_by_id: String(raw), referred_by_name: "", referred_by_enrollment: "" };
}

function serializeReferralQueue(q) {
  if (!Array.isArray(q)) return [];
  return q.map((row) => {
    const rewardType = row.reward_type === "merchandise" ? "merchandise" : "fee_credit";
    const monthsDefault = rewardType === "merchandise" ? 0 : 1;
    return {
      kind: row.kind,
      label: row.label || "",
      monthly_fee_discount_percent: row.monthly_fee_discount_percent,
      months: row.months != null ? row.months : monthsDefault,
      granted_at: row.granted_at,
      source: row.source === "manual_admin" ? "manual_admin" : "auto",
      reward_type: rewardType,
    };
  });
}

function studentResponse(doc) {
  const d = augmentStudentCatalogFieldsFromEnrollment(doc);
  const ref = referredBySummary(d);
  return {
    id: String(d._id),
    email: d.email,
    name: d.name,
    batch: d.batch,
    batch_id: d.batch_id,
    course: d.course,
    progress: d.progress,
    enrollment_date: d.enrollment_date,
    parent_name: d.parent_name,
    phone_number: d.phone_number,
    student_phone: d.student_phone || "",
    whatsapp_number: d.whatsapp_number || "",
    school_name: d.school_name || "",
    cst_registration_id: d.cst_registration_id || "",
    enrollment_number: d.enrollment_number,
    enrollment_batch_prefix: d.enrollment_batch_prefix,
    enrollment_batch_name: d.enrollment_batch_name,
    enrollment_year: d.enrollment_year,
    enrollment_section: d.enrollment_section,
    section_id: d.section_id || "",
    enrollment_roll_no: d.enrollment_roll_no,
    batch_allowance: d.batch_allowance,
    school_class: d.school_class ?? null,
    avatar_url: d.avatar_url || "",
    referral_code: d.referral_code || "",
    ...ref,
    registration_fee_discount_percent: d.registration_fee_discount_percent ?? 0,
    referral_bonus_count: d.referral_bonus_count ?? 0,
    referral_benefits_queue: serializeReferralQueue(d.referral_benefits_queue),
    last_login_at: d.last_login_at || null,
    last_login_ip: d.last_login_ip || "",
    last_login_user_agent: d.last_login_user_agent || "",
  };
}

async function getStudent(req, res) {
  const doc = await Student.findOne({ _id: req.params.id, role: "student" })
    .populate("referred_by", "name enrollment_number referral_code")
    .lean();
  if (!doc) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  const instructorBatches = await getInstructorAssignedBatchIds(req);
  if (instructorBatches !== null && !studentInAnyAssignedBatch(doc, instructorBatches)) {
    return sendError(res, 403, "FORBIDDEN", "Student is not in your assigned batches");
  }

  const data = studentResponse(doc);
  const refCount = await Student.countDocuments({ referred_by: doc._id });
  const bonus = data.referral_bonus_count ?? 0;
  const batchKey = String(data.batch_id || data.batch || "").trim().toLowerCase();
  const arenaProgress = await arenaProgressForStudentId(doc._id, batchKey);
  const assignmentProgress = await assignmentProgressForStudentId(doc._id, batchKey, new Date());
  const solved = arenaProgress.arena_solved_count ?? 0;
  const totalQ = arenaProgress.arena_questions_total ?? 0;
  const asolved = assignmentProgress.assignments_solved_count ?? 0;
  const atotal = assignmentProgress.assignments_total_count ?? 0;
  return sendSuccess(res, {
    ...data,
    referrals_made_count: refCount,
    referrals_total: refCount + bonus,
    ...arenaProgress,
    ...assignmentProgress,
    arenaSolvedCount: solved,
    arenaQuestionsTotal: totalQ,
    assignmentsSolvedCount: asolved,
    assignmentsTotalCount: atotal,
  });
}

async function updateStudent(req, res) {
  const schema = z.object({
    email: z.string().email().optional(),
    name: z.string().min(2).trim().optional(),
    parent_name: z.string().min(2).trim().optional(),
    phone_number: z.string().min(6).trim().optional(),
    enrollment_number: z
      .string()
      .regex(/^[ISBisb]\d{6}$/)
      .optional(),
    enrollment_date: z.coerce.date().optional(),
    // Allow 1–12 on update for older records; UI only offers 5–10 for new edits.
    school_class: z.union([z.number().int().min(1).max(12), z.null()]).optional(),
    school_name: z.string().max(200).trim().optional(),
    student_phone: z.string().max(30).trim().optional(),
    whatsapp_number: z.string().max(30).trim().optional(),
    cst_registration_id: z.string().max(80).trim().optional(),
    referral_bonus_count: z.number().int().min(0).max(500).optional(),
    referral_benefits_append: z
      .array(
        z.object({
          monthly_fee_discount_percent: z.number().min(0).max(100),
          months: z.number().int().min(0).max(36),
          label: z.string().max(300).trim().optional(),
          kind: z.string().max(80).trim().optional(),
          reward_type: z.enum(["fee_credit", "merchandise"]).optional(),
          source: z.enum(["auto", "manual_admin"]).optional(),
        })
      )
      .max(20)
      .optional(),
    /** Replace the entire queue (for admin list UI). Omitted = leave unchanged. Send [] to clear. */
    referral_benefits_queue: z
      .array(
        z.object({
          kind: z.string().max(80).trim().optional(),
          label: z.string().max(300).trim().optional(),
          monthly_fee_discount_percent: z.number().min(0).max(100),
          months: z.number().int().min(0).max(36),
          source: z.enum(["auto", "manual_admin"]).optional(),
          reward_type: z.enum(["fee_credit", "merchandise"]).optional(),
          granted_at: z.coerce.date().optional(),
        })
      )
      .max(50)
      .optional(),
  });
  const body = schema.parse(req.body);

  const doc = await Student.findOne({ _id: req.params.id, role: "student" });
  if (!doc) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  if (body.email && body.email.toLowerCase() !== doc.email) {
    const taken = await Student.findOne({ email: body.email.toLowerCase() }).lean();
    if (taken && String(taken._id) !== String(doc._id)) {
      return sendError(res, 409, "EMAIL_ALREADY_EXISTS", "Email already in use");
    }
    doc.email = body.email.toLowerCase().trim();
  }

  if (body.enrollment_number) {
    let enrollmentParsed;
    try {
      enrollmentParsed = parseEnrollmentNumber(body.enrollment_number);
    } catch (e) {
      return sendError(res, 400, "INVALID_ENROLLMENT_NUMBER", e.message || "Invalid enrollment number");
    }
    const taken = await Student.findOne({ enrollment_number: enrollmentParsed.enrollment_number }).lean();
    if (taken && String(taken._id) !== String(doc._id)) {
      return sendError(res, 409, "ENROLLMENT_ALREADY_EXISTS", "Enrollment number already registered");
    }
    doc.enrollment_number = enrollmentParsed.enrollment_number;
    doc.enrollment_batch_prefix = enrollmentParsed.enrollment_batch_prefix;
    doc.enrollment_batch_name = enrollmentParsed.enrollment_batch_name;
    doc.enrollment_year = enrollmentParsed.enrollment_year;
    doc.enrollment_section = enrollmentParsed.enrollment_section;
    doc.enrollment_roll_no = enrollmentParsed.enrollment_roll_no;
    const derived = deriveStudentBatchFromEnrollment(enrollmentParsed);
    doc.batch = derived.batch;
    doc.batch_id = derived.batch_id;
  }

  if (body.name !== undefined) doc.name = body.name;
  if (body.parent_name !== undefined) doc.parent_name = body.parent_name;
  if (body.phone_number !== undefined) doc.phone_number = body.phone_number;
  if (body.enrollment_date !== undefined) doc.enrollment_date = body.enrollment_date;
  if (body.school_class !== undefined) doc.school_class = body.school_class;
  if (body.school_name !== undefined) doc.school_name = body.school_name;
  if (body.student_phone !== undefined) doc.student_phone = body.student_phone;
  if (body.whatsapp_number !== undefined) doc.whatsapp_number = body.whatsapp_number;
  if (body.cst_registration_id !== undefined) doc.cst_registration_id = body.cst_registration_id;
  if (body.referral_bonus_count !== undefined) doc.referral_bonus_count = body.referral_bonus_count;

  if (body.referral_benefits_queue !== undefined) {
    const built = [];
    for (const row of body.referral_benefits_queue) {
      const rewardType = row.reward_type === "merchandise" ? "merchandise" : "fee_credit";
      if (rewardType === "fee_credit") {
        const mo = row.months;
        if (mo == null || mo < 1 || mo > 36) {
          return sendError(
            res,
            400,
            "INVALID_REFERRAL_BENEFIT",
            "Fee credit rows need months between 1 and 36"
          );
        }
      } else if (row.months != null && row.months !== 0) {
        return sendError(
          res,
          400,
          "INVALID_REFERRAL_BENEFIT",
          "Merchandise rows must have months set to 0"
        );
      }
      const isMerch = rewardType === "merchandise";
      const defaultLabel = isMerch ? "CodeMasti merchandise gift (admin)" : "Manual fee benefit (admin)";
      built.push({
        kind: (row.kind && String(row.kind).trim()) || (isMerch ? "MANUAL_MERCH" : "MANUAL_ADMIN"),
        label: (row.label && String(row.label).trim()) || defaultLabel,
        monthly_fee_discount_percent: isMerch ? 0 : row.monthly_fee_discount_percent,
        months: isMerch ? 0 : row.months,
        from_student_id: null,
        granted_at: row.granted_at != null ? new Date(row.granted_at) : new Date(),
        source: row.source === "auto" ? "auto" : "manual_admin",
        reward_type: rewardType,
      });
    }
    doc.referral_benefits_queue = built;
    doc.markModified("referral_benefits_queue");
  } else if (body.referral_benefits_append && body.referral_benefits_append.length > 0) {
    const at = new Date();
    const existing = Array.isArray(doc.referral_benefits_queue) ? doc.referral_benefits_queue : [];
    for (const row of body.referral_benefits_append) {
      const rewardType = row.reward_type === "merchandise" ? "merchandise" : "fee_credit";
      if (rewardType === "fee_credit") {
        const mo = row.months;
        if (mo == null || mo < 1 || mo > 36) {
          return sendError(
            res,
            400,
            "INVALID_REFERRAL_BENEFIT",
            "Fee credit rows need months between 1 and 36"
          );
        }
      }
      const isMerch = rewardType === "merchandise";
      const defaultLabel = isMerch ? "CodeMasti merchandise gift (admin)" : "Manual fee benefit (admin)";
      existing.push({
        kind: (row.kind && String(row.kind).trim()) || (isMerch ? "MANUAL_MERCH" : "MANUAL_ADMIN"),
        label: (row.label && String(row.label).trim()) || defaultLabel,
        monthly_fee_discount_percent: isMerch ? 0 : row.monthly_fee_discount_percent,
        months: isMerch ? 0 : row.months,
        from_student_id: null,
        granted_at: at,
        source: row.source === "auto" ? "auto" : "manual_admin",
        reward_type: rewardType,
      });
    }
    doc.referral_benefits_queue = existing;
    doc.markModified("referral_benefits_queue");
  }

  applyEnrollmentDerivedFieldsToStudentDocument(doc);
  await doc.save();
  return sendSuccess(res, studentResponse(doc.toObject()), "Student updated");
}

async function uploadStudentAvatar(req, res) {
  if (!req.file?.buffer) {
    return sendError(res, 400, "NO_FILE", 'Expected multipart field "file"');
  }
  const doc = await Student.findOne({ _id: req.params.id, role: "student" });
  if (!doc) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  let avatar_url;

  if (isCloudinaryConfigured()) {
    try {
      const folder = buildStudentAvatarFolder(String(doc._id));
      const result = await uploadBufferToFolder(req.file.buffer, "image", folder);
      avatar_url = result.secure_url || result.url;
    } catch (e) {
      return sendError(res, 500, "AVATAR_UPLOAD_FAILED", e.message || "Avatar upload failed");
    }
  } else {
    fs.mkdirSync(avatarsDir, { recursive: true });
    const ext = path.extname(req.file.originalname || "") || ".jpg";
    const id = String(req.params.id || "").replace(/[^a-f0-9]/gi, "");
    const filename = `student-${id || "x"}-${Date.now()}${ext}`;
    fs.writeFileSync(path.join(avatarsDir, filename), req.file.buffer);
    const rel = `/v1/static/avatars/${filename}`;
    avatar_url = `${req.protocol}://${req.get("host")}${rel}`;
  }

  doc.avatar_url = avatar_url;
  await doc.save();
  return sendSuccess(res, { avatar_url }, "Avatar updated");
}

async function deleteStudent(req, res) {
  const r = await Student.deleteOne({ _id: req.params.id, role: "student" });
  if (r.deletedCount === 0) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  return sendSuccess(res, { id: req.params.id }, "Student removed");
}

/** Map catalog program to enrollment letter (S / B / I). */
const PROGRAM_BATCH_TO_PREFIX = {
  spark: "S",
  builders: "B",
  innovators: "I",
};

/**
 * Rewrites enrollment_number prefix so the student moves to Spark / Builders / Innovators
 * while keeping year, section, and roll digits stable.
 */
async function reassignStudentProgramBatch(req, res) {
  const schema = z.object({
    batch_id: z.enum(["spark", "builders", "innovators"]),
  });
  let body;
  try {
    body = schema.parse(req.body || {});
  } catch {
    return sendError(res, 400, "VALIDATION_ERROR", "batch_id must be spark, builders, or innovators");
  }

  const doc = await Student.findOne({ _id: req.params.id, role: "student" });
  if (!doc) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  const cur = doc.enrollment_number;
  if (!cur || !String(cur).trim()) {
    return sendError(res, 400, "NO_ENROLLMENT", "Student has no enrollment number; set enrollment first.");
  }

  try {
    parseEnrollmentNumber(cur);
  } catch (e) {
    return sendError(res, 400, "INVALID_ENROLLMENT", e.message || "Invalid enrollment number");
  }

  const wantPrefix = PROGRAM_BATCH_TO_PREFIX[body.batch_id];
  const digits = String(cur).trim().toUpperCase().slice(1);
  const next = `${wantPrefix}${digits}`;

  const taken = await Student.findOne({ enrollment_number: next }).lean();
  if (taken && String(taken._id) !== String(doc._id)) {
    return sendError(res, 409, "ENROLLMENT_COLLISION", "That enrollment number is already in use");
  }

  doc.enrollment_number = next;
  applyEnrollmentDerivedFieldsToStudentDocument(doc);
  await doc.save();
  return sendSuccess(res, studentResponse(doc.toObject()), "Program batch updated");
}

module.exports = {
  createStudent,
  listStudents,
  getStudent,
  updateStudent,
  uploadStudentAvatar,
  deleteStudent,
  reassignStudentProgramBatch,
};

