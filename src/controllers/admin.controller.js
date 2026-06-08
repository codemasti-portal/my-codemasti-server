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
const registry = require("../utils/batch-catalog-registry");
const StudentEnrollment = require("../models/StudentEnrollment");
const {
  catalogBatchMongoMatchResolved,
  studentsInBatchesFilterResolved,
} = require("../utils/student-batch-context");
const { assignmentCatalogBatchScopeOr } = require("../utils/assignmentBatchFilter");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildStudentAvatarFolder,
} = require("../utils/cloudinary");
const { getUploadsRoot } = require("../utils/upload-paths");
const { getInstructorAssignedBatchIds, studentInAnyAssignedBatchResolved } = require("../utils/instructorBatchScope");

const uploadsRoot = getUploadsRoot();
const avatarsDir = path.join(uploadsRoot, "avatars");

/** Arena catalog visible to a student's batch (aligned with student arena list). */
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
async function arenaProgressMapsForStudentRows(studentRows, opts = {}) {
  const solvedMap = new Map();
  const totalMap = new Map();

  // Totals/solved span the union of each student's active batches (M:N). Reuse the caller's shared
  // enrollment map when provided (listStudents fetches it once) — otherwise fetch it here.
  const rowIds = studentRows.map((s) => s._id);
  let batchesByStudent = opts.batchesByStudent;
  if (!batchesByStudent) {
    batchesByStudent = new Map();
    for (const s of studentRows) batchesByStudent.set(String(s._id), new Set());
    const enr = await StudentEnrollment.find({ student_id: { $in: rowIds }, status: "active" })
      .select("student_id batch_id")
      .lean();
    for (const e of enr) {
      const b = String(e.batch_id || "").toLowerCase().trim();
      const sid = String(e.student_id);
      if (b && batchesByStudent.has(sid)) batchesByStudent.get(sid).add(b);
    }
  }

  const allBatchKeys = [...new Set([...batchesByStudent.values()].flatMap((set) => [...set]))].filter(Boolean);
  const allQs = await arenaQuestionsForAdminBatchKeys(allBatchKeys);
  const qIdsByBatch = new Map(allBatchKeys.map((bk) => [bk, arenaQuestionIdsForStudentBatch(bk, allQs)]));

  const qidObjById = new Map();
  const questionSetByStudent = new Map();
  for (const s of studentRows) {
    const sid = String(s._id);
    const set = new Set();
    for (const bk of batchesByStudent.get(sid) || []) {
      for (const q of qIdsByBatch.get(bk) || []) {
        const k = String(q);
        set.add(k);
        qidObjById.set(k, q);
      }
    }
    questionSetByStudent.set(sid, set);
    totalMap.set(sid, set.size);
    solvedMap.set(sid, 0);
  }

  const allQidObjs = [...qidObjById.values()];
  if (allQidObjs.length) {
    const agg = await ArenaSubmission.aggregate([
      { $match: { student_id: { $in: rowIds }, status: "Accepted", question_id: { $in: allQidObjs } } },
      { $group: { _id: { sid: "$student_id", qid: "$question_id" } } },
    ]);
    const acceptedByStudent = new Map();
    for (const r of agg) {
      const sid = String(r._id.sid);
      if (!acceptedByStudent.has(sid)) acceptedByStudent.set(sid, new Set());
      acceptedByStudent.get(sid).add(String(r._id.qid));
    }
    for (const s of studentRows) {
      const sid = String(s._id);
      const qset = questionSetByStudent.get(sid) || new Set();
      const accepted = acceptedByStudent.get(sid) || new Set();
      let solved = 0;
      for (const qid of accepted) if (qset.has(qid)) solved += 1;
      solvedMap.set(sid, solved);
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
async function assignmentProgressMapsForStudentRows(studentRows, now = new Date(), opts = {}) {
  const solvedMap = new Map();
  const totalMap = new Map();

  {
    // Union of published assignments across each student's active batches (M:N). Reuse the caller's
    // shared enrollment map when provided (listStudents fetches it once) — otherwise fetch it here.
    const rowIds = studentRows.map((s) => s._id);
    let batchesByStudent = opts.batchesByStudent;
    if (!batchesByStudent) {
      batchesByStudent = new Map();
      for (const s of studentRows) batchesByStudent.set(String(s._id), new Set());
      const enr = await StudentEnrollment.find({ student_id: { $in: rowIds }, status: "active" })
        .select("student_id batch_id")
        .lean();
      for (const e of enr) {
        const b = String(e.batch_id || "").toLowerCase().trim();
        const sid = String(e.student_id);
        if (b && batchesByStudent.has(sid)) batchesByStudent.get(sid).add(b);
      }
    }

    const allBatchKeys = [...new Set([...batchesByStudent.values()].flatMap((set) => [...set]))].filter(Boolean);
    // ONE query for every published assignment scoped to any of these batches (was a per-batch
    // Assignment.find loop), then bucket per batch in memory using the SAME scope as the query
    // (assignmentCatalogBatchScopeOr) so the result is identical.
    const publishedDocs = allBatchKeys.length
      ? await Assignment.find({
          $and: [
            { release_date: { $lte: now } },
            { $or: allBatchKeys.flatMap((bk) => assignmentCatalogBatchScopeOr(bk)) },
          ],
        })
          .select("_id release_date batch_id batch_ids")
          .lean()
      : [];
    const docMatchesBatch = (a, bk) => {
      const primary = String(a.batch_id ?? "").toLowerCase().trim();
      if (!primary) return true; // batch_id absent/"" → visible to all batches (mirrors the $or scope)
      if (primary === bk) return true;
      const arr = Array.isArray(a.batch_ids) ? a.batch_ids.map((x) => String(x ?? "").toLowerCase().trim()) : [];
      return arr.includes(bk);
    };
    const aidsByBatch = new Map(
      allBatchKeys.map((bk) => [bk, publishedDocs.filter((a) => docMatchesBatch(a, bk)).map((a) => String(a._id))])
    );
    const allAids = new Set();
    const aidSetByStudent = new Map();
    for (const s of studentRows) {
      const sid = String(s._id);
      const set = new Set();
      for (const bk of batchesByStudent.get(sid) || []) for (const aid of aidsByBatch.get(bk) || []) { set.add(aid); allAids.add(aid); }
      aidSetByStudent.set(sid, set);
    }
    const allAidList = [...allAids];
    const questions = allAidList.length
      ? await AssignmentQuestion.find({ assignment_id: { $in: allAidList } }).select("_id assignment_id").lean()
      : [];
    const qsByAssignment = new Map();
    const allQidObjs = [];
    for (const q of questions) {
      const aid = String(q.assignment_id);
      if (!qsByAssignment.has(aid)) qsByAssignment.set(aid, []);
      qsByAssignment.get(aid).push(String(q._id));
      allQidObjs.push(q._id);
    }
    const accepted = allQidObjs.length
      ? await AssignmentSubmission.find({ student_id: { $in: rowIds }, status: "Accepted", question_id: { $in: allQidObjs } })
          .select("student_id question_id")
          .lean()
      : [];
    const solvedQsByStudent = new Map();
    for (const r of accepted) {
      const st = String(r.student_id);
      if (!solvedQsByStudent.has(st)) solvedQsByStudent.set(st, new Set());
      solvedQsByStudent.get(st).add(String(r.question_id));
    }
    for (const s of studentRows) {
      const sid = String(s._id);
      const aidsWithQs = [...(aidSetByStudent.get(sid) || new Set())].filter((aid) => (qsByAssignment.get(aid) || []).length > 0);
      totalMap.set(sid, aidsWithQs.length);
      const solvedSet = solvedQsByStudent.get(sid) || new Set();
      let solvedCount = 0;
      for (const aid of aidsWithQs) {
        const qids = qsByAssignment.get(aid) || [];
        if (qids.length && qids.every((qid) => solvedSet.has(qid))) solvedCount += 1;
      }
      solvedMap.set(sid, solvedCount);
    }
    return { solvedMap, totalMap };
  }
}

/**
 * Next available PRIMARY enrollment number for a batch + section: `<LETTER><YY><SS><RR>`.
 * - LETTER = the batch's single-letter enrollment_prefix. A batch can host a primary enrollment only
 *   if it has a 1-letter prefix; 2-letter-prefix batches can only be secondary (Add to batch → roll_number).
 * - YY     = current year (2 digits).
 * - SS     = the chosen catalog section as 2 digits (its id if numeric, else its 1-based position).
 * - RR     = next free 2-digit roll within LETTER+YY+SS (max existing + 1).
 * Throws an Error with a `.code` the caller surfaces.
 */
async function generateNextEnrollmentNumber(batchId, sectionId) {
  await registry.refresh();
  const bid = String(batchId || "").toLowerCase().trim();
  const prefix = registry.batchIdToPrefixSync(bid);
  if (!prefix) {
    const e = new Error(`Batch "${bid}" has no enrollment prefix — set one in the batch catalog, or add the student as a secondary batch.`);
    e.code = "NO_PREFIX";
    throw e;
  }
  const letter = prefix.toUpperCase(); // 1+ letters (e.g. I, SU, ADV)
  const yy = String(new Date().getFullYear()).slice(-2);

  // Resolve the 2-digit section code (SS): the section id if it's already 1–2 digits, else its
  // 1-based position among the batch's catalog sections (defaults to 01).
  const sections = registry.getBatchSync(bid)?.sections || [];
  const rawSection = String(sectionId || "").trim().toLowerCase();
  let ss;
  if (/^\d{1,2}$/.test(rawSection)) {
    ss = rawSection.padStart(2, "0");
  } else if (rawSection) {
    const idx = sections.findIndex((s) => String(s.section_id || "").toLowerCase() === rawSection);
    ss = String((idx >= 0 ? idx : 0) + 1).padStart(2, "0");
  } else {
    ss = "01";
  }

  // Fill the SMALLEST free roll in 01..99 (not max+1) — existing rolls are often scattered with gaps,
  // and gap-filling keeps every student inside the same 2-digit section code (matches the catalog section).
  const rx = new RegExp(`^${letter}${yy}${ss}(\\d{2})$`, "i");
  const rows = await Student.find({ enrollment_number: rx }).select("enrollment_number").lean();
  const used = new Set();
  for (const r of rows) {
    const m = rx.exec(String(r.enrollment_number || ""));
    if (m) used.add(Number(m[1]));
  }
  let next = 1;
  while (next <= 99 && used.has(next)) next++;
  if (next > 99) {
    const e = new Error(`Section ${ss} of "${bid}" is full (all 99 rolls used). Pick a different section.`);
    e.code = "SECTION_FULL";
    throw e;
  }
  const rr = String(next).padStart(2, "0");
  return { enrollment_number: `${letter}${yy}${ss}${rr}`, prefix: letter, year: yy, section: ss, roll: rr };
}

/** GET /admin/students/next-enrollment?batch_id=&section_id= — preview the next primary enrollment number. */
async function nextEnrollmentNumber(req, res) {
  const batchId = String(req.query.batch_id || "").trim().toLowerCase();
  const sectionId = String(req.query.section_id || "").trim();
  if (!batchId) return sendError(res, 400, "VALIDATION_ERROR", "batch_id is required");
  try {
    return sendSuccess(res, await generateNextEnrollmentNumber(batchId, sectionId));
  } catch (e) {
    return sendError(res, 400, e.code || "ENROLLMENT_GEN_FAILED", e.message || "Could not generate enrollment number");
  }
}

/**
 * GET /admin/students/lookup?email= — does a student already exist for this email?
 * Drives the create dialog's branch: exists → Add-to-batch, new → Create.
 */
async function lookupStudentByEmail(req, res) {
  const email = String(req.query.email || "").trim();
  if (!email) return sendError(res, 400, "VALIDATION_ERROR", "email is required");
  const student = await Student.findOne({
    role: "student",
    email: new RegExp(`^${referralRewards.escapeRegex(email)}$`, "i"),
  })
    .select("_id name email enrollment_number")
    .lean();
  if (!student) return sendSuccess(res, { exists: false });
  const enr = await StudentEnrollment.find({ student_id: student._id, status: "active" }).select("batch_id").lean();
  const batch_ids = [...new Set(enr.map((e) => String(e.batch_id || "").toLowerCase()).filter(Boolean))];
  return sendSuccess(res, {
    exists: true,
    student: {
      id: String(student._id),
      name: student.name,
      email: student.email,
      enrollment_number: student.enrollment_number || "",
      batch_ids,
    },
  });
}

async function createStudent(req, res) {
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(2).trim(),
    parent_name: z.string().min(2).trim(),
    phone_number: z.string().min(6).trim(),
    enrollment_number: z
      .string()
      // Batch prefix (1+ letters) + 6 digits. The prefix must map to a known batch in the catalog —
      // validated by parseEnrollmentNumber below (registry-aware), so new batch types are supported.
      .regex(/^[A-Za-z]+\d{6}$/, "enrollment_number must be a batch prefix + 6 digits (e.g. I260105, SU260206)"),
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

  // Auto-create the StudentEnrollment row matching the derived batch_id, so the new student is
  // immediately picked up by billing (bulk-generate, Fees tab, reconciliation). Best-effort — if
  // no Course is configured for this batch yet, we surface the reason via the response meta but
  // don't fail the student creation itself.
  let enrollmentSync = null;
  try {
    const { syncEnrollmentToBatch } = require("../services/enrollment-sync.service");
    enrollmentSync = await syncEnrollmentToBatch({
      studentId: created._id,
      oldBatchId: "",
      newBatchId: created.batch_id,
      actorStaffId: req.staff?.sub,
    });
  } catch (err) {
    enrollmentSync = { changed: false, action: "error", error: err.message };
  }

  // The primary (home) batch's roll = the permanent enrollment_number (its letter already encodes
  // the home batch). Secondary batches get their own auto-generated rolls when added. enrollment_number
  // is globally unique, so this never collides within the batch. Best-effort, non-fatal.
  try {
    if (enrollmentSync?.new_enrollment_id && created.enrollment_number) {
      await StudentEnrollment.updateOne(
        { _id: enrollmentSync.new_enrollment_id, $or: [{ roll_number: "" }, { roll_number: { $exists: false } }] },
        { $set: { roll_number: created.enrollment_number } }
      );
    }
  } catch (_e) {
    /* roll stamping is non-fatal — never block student creation on it */
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
    "Student created",
    enrollmentSync ? { enrollment_sync: enrollmentSync } : undefined
  );
}

/**
 * Total XP (assignment + arena, across all batches) for a set of student ids → Map(studentId → xp).
 * Mirrors the public leaderboard's effective-XP rule (awarded/credited, else the question's full xp).
 */
async function studentTotalXp(studentIds) {
  const ids = (studentIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const [assignmentXpRows, arenaXpRows] = await Promise.all([
    AssignmentSubmission.aggregate([
      { $match: { student_id: { $in: ids }, status: "Accepted" } },
      { $lookup: { from: "assignmentquestions", localField: "question_id", foreignField: "_id", as: "q" } },
      { $unwind: { path: "$q", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { student_id: "$student_id", question_id: "$question_id" },
          best_xp_awarded: { $max: { $ifNull: ["$xp_awarded", 0] } },
          full_xp: { $max: { $ifNull: ["$q.xp", 0] } },
        },
      },
      { $addFields: { effective_xp: { $cond: [{ $gt: ["$best_xp_awarded", 0] }, "$best_xp_awarded", "$full_xp"] } } },
      { $group: { _id: "$_id.student_id", xp: { $sum: "$effective_xp" } } },
    ]),
    ArenaSubmission.aggregate([
      { $match: { student_id: { $in: ids }, status: "Accepted" } },
      { $group: { _id: { student_id: "$student_id", question_id: "$question_id" }, credited: { $max: { $ifNull: ["$xp_credited", 0] } } } },
      { $lookup: { from: "arenaquestions", localField: "_id.question_id", foreignField: "_id", as: "q" } },
      { $unwind: "$q" },
      { $addFields: { effective_xp: { $cond: [{ $gt: ["$credited", 0] }, "$credited", { $max: [{ $toInt: { $ifNull: ["$q.xp", 0] } }, 0] }] } } },
      { $group: { _id: "$_id.student_id", xp: { $sum: "$effective_xp" } } },
    ]),
  ]);
  const m = new Map();
  for (const row of assignmentXpRows) m.set(String(row._id), Math.max(0, Number(row.xp || 0)));
  for (const row of arenaXpRows) {
    const id = String(row._id);
    m.set(id, Math.max(0, Number(m.get(id) || 0)) + Math.max(0, Number(row.xp || 0)));
  }
  return m;
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
    // M:N: a student belongs to a batch via active enrollment, not just the legacy primary field.
    // Resolved helper is byte-identical to catalogBatchMongoMatch under legacy mode.
    andParts.push(await catalogBatchMongoMatchResolved(batchKey));
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
    // M:N-aware: include students in the instructor's batches via active enrollment too.
    andParts.push(await studentsInBatchesFilterResolved(instructorBatches));
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

  const uniqIds = (arr) => [...new Map(arr.filter(Boolean).map((id) => [String(id), id])).values()];
  const pageIds = items.map((s) => s._id).filter(Boolean);

  // ---- ONE active-enrollment fetch for the page → batches + the section held in each batch. Shared
  // by the arena/assignment progress maps and the response (was fetched 3× before: each map helper
  // + here). M:N: a multi-batch student shows the right section when a batch tab is selected.
  const pageEnrollments = pageIds.length
    ? await StudentEnrollment.find({ student_id: { $in: pageIds }, status: "active" })
        .select("student_id batch_id section_id")
        .lean()
    : [];
  const batchesByStudent = new Map(items.map((s) => [String(s._id), new Set()]));
  const batchIdsByStudent = new Map();
  const sectionByStudentBatch = new Map();
  for (const e of pageEnrollments) {
    const sid = String(e.student_id);
    const b = String(e.batch_id || "").toLowerCase().trim();
    if (!b) continue;
    if (batchesByStudent.has(sid)) batchesByStudent.get(sid).add(b);
    if (!batchIdsByStudent.has(sid)) batchIdsByStudent.set(sid, []);
    if (!batchIdsByStudent.get(sid).includes(b)) batchIdsByStudent.get(sid).push(b);
    sectionByStudentBatch.set(`${sid}:${b}`, String(e.section_id || "").toLowerCase().trim());
  }

  // batch_rank context per displayed student: the filtered batch (batchKey) if set, else primary.
  const rankBatchByStudent = new Map();
  for (const s of items) {
    const ctx = batchKey || String(s.batch_id || "").toLowerCase().trim();
    if (ctx) rankBatchByStudent.set(String(s._id), ctx);
  }
  const rankBatches = [...new Set(rankBatchByStudent.values())];

  // These enrichment phases are mutually independent (they only read `items` + the shared batch maps),
  // so run them CONCURRENTLY instead of sequentially — the previous version awaited each in turn,
  // which on a high-latency tier serialized ~a dozen round-trips.
  const [{ totalXpByStudent, batchRankByStudent }, verifiedByReferrer, arenaMaps, assignmentMaps] =
    await Promise.all([
      // ---- total XP (across batches) + batch_rank, from a SINGLE union XP aggregation.
      // batch_rank ranks each displayed student within their batch context among that batch's ACTIVE
      // enrollment members (M:N). Members for every rank-batch resolved in one grouped enrollment query;
      // XP computed once for {displayed students} ∪ {all rank-batch members} and reused for both.
      (async () => {
        const memberIdsByBatch = new Map(rankBatches.map((b) => [b, []]));
        if (rankBatches.length) {
          const memberEnr = await StudentEnrollment.find({ batch_id: { $in: rankBatches }, status: "active" })
            .select("student_id batch_id")
            .lean();
          for (const e of memberEnr) {
            const b = String(e.batch_id || "").toLowerCase().trim();
            if (memberIdsByBatch.has(b) && e.student_id) memberIdsByBatch.get(b).push(e.student_id);
          }
        }
        const allMemberIds = uniqIds([...memberIdsByBatch.values()].flat());
        const xp = await studentTotalXp(uniqIds([...pageIds, ...allMemberIds]));
        const nameById = new Map();
        if (allMemberIds.length) {
          const memberDocs = await Student.find({ _id: { $in: allMemberIds } }).select("_id name").lean();
          for (const m of memberDocs) nameById.set(String(m._id), m.name || "");
        }
        const rankMap = new Map();
        for (const rb of rankBatches) {
          const ranked = uniqIds(memberIdsByBatch.get(rb) || []).map((id) => String(id));
          if (!ranked.length) continue;
          ranked.sort((a, b) => {
            const ax = Number(xp.get(a) || 0);
            const bx = Number(xp.get(b) || 0);
            if (bx !== ax) return bx - ax;
            return String(nameById.get(a) || "").localeCompare(String(nameById.get(b) || ""));
          });
          ranked.forEach((sid, idx) => {
            if (rankBatchByStudent.get(sid) === rb) rankMap.set(sid, idx + 1);
          });
        }
        return { totalXpByStudent: xp, batchRankByStudent: rankMap };
      })(),
      // ---- referral counts (how many students each displayed student referred)
      (async () => {
        if (!pageIds.length) return new Map();
        const agg = await Student.aggregate([
          { $match: { role: "student", referred_by: { $in: pageIds } } },
          { $group: { _id: "$referred_by", c: { $sum: 1 } } },
        ]);
        return new Map(agg.map((row) => [String(row._id), row.c]));
      })(),
      // ---- arena + assignment progress (reuse the shared enrollment map; no extra enrollment fetch)
      items.length
        ? arenaProgressMapsForStudentRows(items, { batchesByStudent })
        : Promise.resolve({ solvedMap: new Map(), totalMap: new Map() }),
      items.length
        ? assignmentProgressMapsForStudentRows(items, new Date(), { batchesByStudent })
        : Promise.resolve({ solvedMap: new Map(), totalMap: new Map() }),
    ]);

  const arenaSolvedMap = arenaMaps.solvedMap;
  const arenaTotalMap = arenaMaps.totalMap;
  const assignmentSolvedMap = assignmentMaps.solvedMap;
  const assignmentTotalMap = assignmentMaps.totalMap;

  const data = items.map((s) => {
    const base = studentResponse(s);
    const verified = verifiedByReferrer.get(String(s._id)) || 0;
    const bonus = base.referral_bonus_count ?? 0;
    const sid = mongoEntityKey(s._id);
    const arenaSolved = arenaSolvedMap.get(sid) ?? arenaSolvedMap.get(String(base.id)) ?? 0;
    const arenaTotal = arenaTotalMap.get(sid) ?? arenaTotalMap.get(String(base.id)) ?? 0;
    const assignSolved = assignmentSolvedMap.get(sid) ?? assignmentSolvedMap.get(String(base.id)) ?? 0;
    const assignTotal = assignmentTotalMap.get(sid) ?? assignmentTotalMap.get(String(base.id)) ?? 0;
    const studentBatchIds = batchIdsByStudent.get(sid) || (base.batch_id ? [base.batch_id] : []);
    const sectionInFilteredBatch =
      batchKey && sectionByStudentBatch.has(`${sid}:${batchKey}`)
        ? sectionByStudentBatch.get(`${sid}:${batchKey}`)
        : base.section_id;
    return {
      ...base,
      section_id: sectionInFilteredBatch,
      batch_ids: studentBatchIds,
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
  if (instructorBatches !== null && !(await studentInAnyAssignedBatchResolved(doc, instructorBatches))) {
    return sendError(res, 403, "FORBIDDEN", "Student is not in your assigned batches");
  }

  const data = studentResponse(doc);
  const refCount = await Student.countDocuments({ referred_by: doc._id });
  const bonus = data.referral_bonus_count ?? 0;
  let arenaProgress;
  let assignmentProgress;
  {
    // M:N: aggregate across the student's active batches via the membership-aware maps.
    const sid = String(doc._id);
    const aMaps = await arenaProgressMapsForStudentRows([doc]);
    arenaProgress = { arena_solved_count: aMaps.solvedMap.get(sid) || 0, arena_questions_total: aMaps.totalMap.get(sid) || 0 };
    const asgMaps = await assignmentProgressMapsForStudentRows([doc], new Date());
    assignmentProgress = { assignments_solved_count: asgMaps.solvedMap.get(sid) || 0, assignments_total_count: asgMaps.totalMap.get(sid) || 0 };
  }
  const solved = arenaProgress.arena_solved_count ?? 0;
  const totalQ = arenaProgress.arena_questions_total ?? 0;
  const asolved = assignmentProgress.assignments_solved_count ?? 0;
  const atotal = assignmentProgress.assignments_total_count ?? 0;

  // Active batch memberships (+ per-batch roll number) for the multi-batch UI. Academic only
  // (no fees) so it is safe for instructors who can view students. Falls back to the primary batch.
  const activeEnr = await StudentEnrollment.find({ student_id: doc._id, status: "active" })
    .select("batch_id roll_number")
    .lean();
  const batches = [];
  for (const e of activeEnr) {
    const b = String(e.batch_id || "").toLowerCase().trim();
    if (!b) continue;
    batches.push({ batch_id: b, batch_name: registry.displayNameSync(b) || b, roll_number: e.roll_number || "" });
  }
  if (!batches.length && data.batch_id) {
    const b = String(data.batch_id).toLowerCase().trim();
    batches.push({ batch_id: b, batch_name: data.batch || registry.displayNameSync(b) || b, roll_number: data.enrollment_number || "" });
  }

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
    batches,
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
      .regex(/^[A-Za-z]+\d{6}$/, "enrollment_number must be a batch prefix + 6 digits (e.g. I260105, SU260206)")
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

  // Capture pre-mutation batch_id so we can sync StudentEnrollment after save (see end of fn).
  const previousBatchId = doc.batch_id || "";

  if (body.enrollment_number) {
    let enrollmentParsed;
    try {
      enrollmentParsed = parseEnrollmentNumber(body.enrollment_number);
    } catch (e) {
      return sendError(res, 400, "INVALID_ENROLLMENT_NUMBER", e.message || "Invalid enrollment number");
    }
    const currentEnr = String(doc.enrollment_number || "").trim().toUpperCase();
    const nextEnr = String(enrollmentParsed.enrollment_number || "").trim().toUpperCase();
    // The enrollment number is the student's PERMANENT identity — it also derives their primary batch
    // and roll. Renaming it would silently move batches and break references, so it's immutable once
    // set. Batch changes go through Add/Remove batch instead. (A legacy student with no number yet may
    // still receive an initial one.)
    if (currentEnr && currentEnr !== nextEnr) {
      return sendError(
        res,
        409,
        "ENROLLMENT_IMMUTABLE",
        "Enrollment number is permanent and cannot be changed. Use Add/Remove batch to move a student between batches."
      );
    }
    if (!currentEnr) {
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
    // else: same value provided → no-op (identity unchanged)
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

  // If batch_id changed (e.g. enrollment_number rename moved them between Spark/Builders/Innovators),
  // sync their StudentEnrollment so billing follows. Best-effort: failures are surfaced in meta but
  // don't fail the whole Student update.
  let enrollmentSync = null;
  const newBatchId = doc.batch_id || "";
  if (newBatchId.toLowerCase() !== previousBatchId.toLowerCase()) {
    try {
      const { syncEnrollmentToBatch } = require("../services/enrollment-sync.service");
      enrollmentSync = await syncEnrollmentToBatch({
        studentId: doc._id,
        oldBatchId: previousBatchId,
        newBatchId,
        actorStaffId: req.staff?.sub,
      });
    } catch (err) {
      enrollmentSync = { changed: false, action: "error", error: err.message };
    }
  }

  return sendSuccess(
    res,
    studentResponse(doc.toObject()),
    "Student updated",
    enrollmentSync ? { enrollment_sync: enrollmentSync } : undefined
  );
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

/**
 * POST /admin/students/:id/batches — add a student to a batch (additive; multi-batch).
 * Body: { batch_id, section_id? }. Creates/reactivates the active enrollment for that batch's
 * course without touching the student's other batches.
 */
async function addStudentBatch(req, res) {
  const id = req.params.id;
  if (!/^[0-9a-fA-F]{24}$/.test(String(id || ""))) return sendError(res, 400, "INVALID_ID", "Invalid student id");
  const schema = z.object({
    batch_id: z.string().trim().min(1).transform((s) => s.toLowerCase()),
    section_id: z.string().trim().optional().default(""),
  });
  let body;
  try {
    body = schema.parse(req.body || {});
  } catch {
    return sendError(res, 400, "VALIDATION_ERROR", "batch_id is required");
  }

  const student = await Student.findById(id).select("_id").lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  await registry.refresh();
  if (!registry.isKnownBatchIdSync(body.batch_id)) {
    return sendError(res, 400, "VALIDATION_ERROR", `Unknown or inactive batch_id "${body.batch_id}"`);
  }

  const { addStudentToBatch, recomputePrimaryBatchCache } = require("../services/enrollment-sync.service");
  const result = await addStudentToBatch({
    studentId: id,
    batchId: body.batch_id,
    sectionId: body.section_id,
    actorStaffId: req.staff?.sub,
    source: "admin_manual",
  });
  if (result.action === "skipped_no_course") {
    return sendError(res, 409, "NO_COURSE_FOR_BATCH", result.detail || "No active course is linked to this batch.");
  }
  if (result.changed) await recomputePrimaryBatchCache(id);
  return sendSuccess(res, result, result.changed ? "Student added to batch" : "Student already in this batch");
}

/**
 * DELETE /admin/students/:id/batches/:batch_id — remove a student from one batch (targeted).
 * Completes only that batch's active enrollment; the student's other batches are untouched.
 */
async function removeStudentBatch(req, res) {
  const id = req.params.id;
  if (!/^[0-9a-fA-F]{24}$/.test(String(id || ""))) return sendError(res, 400, "INVALID_ID", "Invalid student id");
  const batchId = String(req.params.batch_id || "").toLowerCase().trim();
  if (!batchId) return sendError(res, 400, "VALIDATION_ERROR", "batch_id is required");

  const student = await Student.findById(id).select("_id").lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  const { removeStudentFromBatch, recomputePrimaryBatchCache } = require("../services/enrollment-sync.service");
  const result = await removeStudentFromBatch({ studentId: id, batchId, actorStaffId: req.staff?.sub });
  if (result.changed) await recomputePrimaryBatchCache(id);
  return sendSuccess(res, result, result.changed ? "Student removed from batch" : "Student was not active in this batch");
}

module.exports = {
  createStudent,
  nextEnrollmentNumber,
  lookupStudentByEmail,
  listStudents,
  getStudent,
  updateStudent,
  uploadStudentAvatar,
  deleteStudent,
  addStudentBatch,
  removeStudentBatch,
};

