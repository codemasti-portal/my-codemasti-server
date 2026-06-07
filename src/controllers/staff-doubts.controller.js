const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const PersonalDoubt = require("../models/PersonalDoubt");
const CommunityMessage = require("../models/CommunityMessage");
const Student = require("../models/Student");
const Staff = require("../models/Staff");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildCommunityUploadFolder,
  buildDoubtsUploadFolder,
} = require("../utils/cloudinary");
const registry = require("../utils/batch-catalog-registry");
const { membershipMode, studentIdsInBatches } = require("../utils/student-batch-context");

function mediaResourceType(mimetype) {
  const type = String(mimetype || "");
  if (/^image\/(jpeg|png|webp|gif)$/.test(type)) return "image";
  if (/^video\/(mp4|quicktime|x-matroska|webm)$/.test(type)) return "video";
  return "raw";
}

function mediaKindFromResourceType(resourceType) {
  if (resourceType === "image") return "image";
  if (resourceType === "video") return "video";
  return "file";
}

async function uploadCommunityMedia(req) {
  if (!req.file?.buffer) return null;
  const resourceType = mediaResourceType(req.file.mimetype);
  if (isCloudinaryConfigured()) {
    const folder = buildCommunityUploadFolder(resourceType);
    const result = await uploadBufferToFolder(req.file.buffer, resourceType, folder, {
      filenameOverride: req.file.originalname || "",
    });
    return {
      url: result.secure_url || result.url,
      mime_type: req.file.mimetype || "",
      file_name: req.file.originalname || "",
      bytes: Number(result.bytes || req.file.size || 0),
      kind: mediaKindFromResourceType(resourceType),
    };
  }

  const fallbackBase = `${req.protocol}://${req.get("host")}`;
  return {
    // No cloud configured; return a data URL is not practical for large files, so require Cloudinary for media.
    url: "",
    mime_type: req.file.mimetype || "",
    file_name: req.file.originalname || "",
    bytes: Number(req.file.size || 0),
    kind: mediaKindFromResourceType(resourceType),
    _fallbackBase: fallbackBase,
  };
}

/**
 * What doubts may this staff member see/act on?
 *   - super_admin / admin → everything (a shared pool)
 *   - instructor          → their assigned batches
 *   - mentor              → their assigned students
 */
async function resolveDoubtScope(req) {
  const role = String(req.staff?.role || "").toLowerCase();
  if (role === "super_admin" || role === "admin") return { mode: "all" };
  const staff = await Staff.findById(req.staff?.sub).select("batches_assigned assigned_students").lean();
  if (role === "instructor") {
    const batchIds = [
      ...new Set((staff?.batches_assigned || []).map((b) => String(b || "").trim().toLowerCase()).filter(Boolean)),
    ];
    return { mode: "instructor", batchIds };
  }
  if (role === "mentor") {
    const studentIds = [...new Set((staff?.assigned_students || []).map((s) => String(s || "").trim()).filter(Boolean))];
    return { mode: "mentor", studentIds };
  }
  return { mode: "none" };
}

/** Student _ids in a batch scope (mode-gated: legacy primary field vs M:N active enrollments). */
async function studentIdsForBatchScope(batchScope) {
  if (!batchScope.length) return [];
  if (membershipMode() === "legacy") {
    const rows = await Student.find({ batch_id: { $in: batchScope } }).select("_id").lean();
    return rows.map((s) => s._id);
  }
  return studentIdsInBatches(batchScope);
}

/** Distinct batch_ids a set of students belong to (to scope a mentor's community channels). */
async function batchIdsForStudents(studentIds) {
  if (!studentIds.length) return [];
  if (membershipMode() === "legacy") {
    const rows = await Student.find({ _id: { $in: studentIds } }).select("batch_id").lean();
    return [...new Set(rows.map((s) => String(s.batch_id || "").toLowerCase()).filter(Boolean))];
  }
  const StudentEnrollment = require("../models/StudentEnrollment");
  const rows = await StudentEnrollment.find({ student_id: { $in: studentIds }, status: "active" })
    .select("batch_id")
    .lean();
  return [...new Set(rows.map((e) => String(e.batch_id || "").toLowerCase()).filter(Boolean))];
}

/** Write-guard: may this staff answer/act on a doubt from `studentId`? */
async function staffCanAccessStudent(scope, studentId) {
  if (scope.mode === "all") return true;
  const sid = String(studentId || "");
  if (scope.mode === "mentor") return scope.studentIds.map(String).includes(sid);
  if (scope.mode === "instructor") {
    if (!scope.batchIds.length) return false;
    const ids = new Set((await studentIdsForBatchScope(scope.batchIds)).map((x) => String(x)));
    return ids.has(sid);
  }
  return false;
}

/** Write-guard: may this staff post in `batchId`'s community channel? */
async function staffCanAccessBatch(scope, batchId) {
  const bid = String(batchId || "").toLowerCase();
  if (scope.mode === "all") return true;
  if (scope.mode === "instructor") return scope.batchIds.includes(bid);
  if (scope.mode === "mentor") return (await batchIdsForStudents(scope.studentIds)).includes(bid);
  return false;
}

async function listPersonal(req, res) {
  const status = String(req.query.status || "pending").trim().toLowerCase();
  const filter = {};
  const batchId = String(req.query.batch_id || "").trim().toLowerCase();
  const includeAllDefaultBatches =
    String(req.query.all || "").trim() === "1" || String(req.query.all || "").trim().toLowerCase() === "true";
  if (status === "pending" || status === "answered") filter.status = status;

  const scope = await resolveDoubtScope(req);
  if (scope.mode === "mentor") {
    // Mentor: only their assigned students' doubts (optionally narrowed to a requested batch).
    if (!scope.studentIds.length) return sendSuccess(res, []);
    let ids = scope.studentIds;
    if (batchId) {
      const inBatch = new Set((await studentIdsForBatchScope([batchId])).map((x) => String(x)));
      ids = ids.filter((id) => inBatch.has(String(id)));
    }
    filter.student_id = { $in: ids };
  } else if (scope.mode === "instructor") {
    // Instructor: only their assigned batches (intersected with a requested batch).
    if (!scope.batchIds.length) return sendSuccess(res, []);
    const batchScope = batchId ? (scope.batchIds.includes(batchId) ? [batchId] : []) : scope.batchIds;
    if (!batchScope.length) return sendSuccess(res, []);
    filter.student_id = { $in: await studentIdsForBatchScope(batchScope) };
  } else if (scope.mode === "all") {
    // Admin / super_admin: unchanged — all doubts, or scoped to a batch / the default-views set.
    if (includeAllDefaultBatches || batchId) {
      const batchScope = includeAllDefaultBatches ? registry.defaultViewBatchIdsSync() : [batchId];
      filter.student_id = { $in: await studentIdsForBatchScope(batchScope) };
    }
  } else {
    return sendSuccess(res, []);
  }

  const rows = await PersonalDoubt.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const studentIds = [...new Set(rows.map((r) => String(r.student_id)).filter(Boolean))];
  const students = await Student.find({ _id: { $in: studentIds } })
    .select("name email batch_id section_id")
    .lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const data = rows.map((d) => {
    const s = byId.get(String(d.student_id));
    return {
      id: String(d._id),
      student_id: String(d.student_id),
      student_name: s?.name || "Student",
      student_email: s?.email || "",
      batch_id: s?.batch_id || "",
      section_id: s?.section_id || "",
      subject: d.subject,
      title: d.title,
      description: d.description,
      code: d.code,
      image_url: d.image_url,
      status: d.status,
      teacher_name: d.teacher_name || "",
      teacher_reply: d.teacher_reply || "",
      teacher_reply_code: d.teacher_reply_code || "",
      teacher_reply_image_url: d.teacher_reply_image_url || "",
      answered_at: d.answered_at || null,
      created_at: d.createdAt,
    };
  });
  return sendSuccess(res, data);
}

async function answerPersonal(req, res) {
  const schema = z.object({
    teacher_reply: z.string().max(5000).trim().optional().default(""),
    teacher_reply_code: z.string().max(20000).optional().default(""),
  });
  const body = schema.parse(req.body || {});
  const text = String(body.teacher_reply || "").trim();
  const code = String(body.teacher_reply_code || "").trim();
  let imageUrl = "";
  if (req.file?.buffer) {
    if (!isCloudinaryConfigured()) {
      return sendError(
        res,
        503,
        "CLOUDINARY_NOT_CONFIGURED",
        "Doubt reply image upload requires Cloudinary configuration"
      );
    }
    const folder = buildDoubtsUploadFolder("image");
    const result = await uploadBufferToFolder(req.file.buffer, "image", folder, {
      filenameOverride: req.file.originalname || "",
    });
    imageUrl = result.secure_url || result.url || "";
  }
  if (!text && !code && !imageUrl) {
    return sendError(res, 400, "VALIDATION_ERROR", "Provide reply text, code, or image");
  }
  const doc = await PersonalDoubt.findById(req.params.id);
  if (!doc) return sendError(res, 404, "DOUBT_NOT_FOUND", "Personal doubt not found");
  const scope = await resolveDoubtScope(req);
  if (!(await staffCanAccessStudent(scope, doc.student_id))) {
    return sendError(res, 403, "FORBIDDEN", "This doubt is outside your assigned scope");
  }
  const staff = await Staff.findById(req.staff.sub).select("name").lean();
  doc.status = "answered";
  doc.teacher_reply = text;
  doc.teacher_reply_code = code;
  if (imageUrl) doc.teacher_reply_image_url = imageUrl;
  doc.teacher_name = staff?.name || "Instructor";
  doc.answered_at = new Date();
  doc.unread_by_student = true;
  await doc.save();
  return sendSuccess(res, { id: String(doc._id), status: doc.status }, "Reply saved");
}

async function listCommunity(req, res) {
  const batchId = String(req.query.batch_id || "").trim().toLowerCase();
  const includeAllDefaultBatches =
    String(req.query.all || "").trim() === "1" || String(req.query.all || "").trim().toLowerCase() === "true";
  const scope = await resolveDoubtScope(req);

  let filter = null;
  if (scope.mode === "all") {
    if (includeAllDefaultBatches) {
      filter = { channel_id: { $in: registry.defaultViewBatchIdsSync() } };
    } else {
      if (!batchId) return sendError(res, 400, "VALIDATION_ERROR", "batch_id is required");
      filter = { channel_id: batchId };
    }
  } else {
    // instructor → assigned batches; mentor → batches of their assigned students.
    const allowed = scope.mode === "instructor" ? scope.batchIds : await batchIdsForStudents(scope.studentIds);
    if (!allowed.length) return sendSuccess(res, []);
    if (batchId) {
      if (!allowed.includes(batchId)) return sendSuccess(res, []);
      filter = { channel_id: batchId };
    } else {
      filter = { channel_id: { $in: allowed } };
    }
  }
  const rows = await CommunityMessage.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const myStaffId = String(req.staff.sub || "");
  const staffIds = [...new Set(rows.map((m) => String(m.staff_id || "")).filter(Boolean))];
  const studentIds = [...new Set(rows.map((m) => String(m.student_id || "")).filter(Boolean))];
  const [staffRows, studentRows] = await Promise.all([
    staffIds.length
      ? Staff.find({ _id: { $in: staffIds } }).select("profile_image_url").lean()
      : Promise.resolve([]),
    studentIds.length
      ? Student.find({ _id: { $in: studentIds } }).select("avatar_url").lean()
      : Promise.resolve([]),
  ]);
  const staffAvatarById = new Map(staffRows.map((s) => [String(s._id), s.profile_image_url || ""]));
  const studentAvatarById = new Map(studentRows.map((s) => [String(s._id), s.avatar_url || ""]));
  const data = rows.reverse().map((m) => ({
    staffId: m.staff_id ? String(m.staff_id) : "",
    studentId: m.student_id ? String(m.student_id) : "",
    id: String(m._id),
    channel_id: m.channel_id,
    author_name: m.author_name || "User",
    author_role: m.author_role || "student",
    is_mine: myStaffId ? String(m.staff_id || "") === myStaffId : false,
    author_avatar_url: m.staff_id
      ? staffAvatarById.get(String(m.staff_id)) || ""
      : m.student_id
        ? studentAvatarById.get(String(m.student_id)) || ""
        : "",
    text: m.text || "",
    code: m.code || null,
    media: m.media || null,
    is_hidden: !!m.is_hidden,
    likes: Array.isArray(m.likes) ? m.likes.length : 0,
    created_at: m.createdAt,
  }));
  return sendSuccess(res, data);
}

async function hideCommunity(req, res) {
  const messageId = String(req.params.id || "").trim();
  if (!messageId) return sendError(res, 400, "VALIDATION_ERROR", "Message id is required");
  const doc = await CommunityMessage.findOneAndUpdate(
    { _id: messageId, is_hidden: { $ne: true } },
    {
      $set: {
        is_hidden: true,
        hidden_by_staff_id: req.staff.sub,
        hidden_at: new Date(),
        text: "Hidden by admin",
        code: undefined,
        media: undefined,
      },
    },
    { new: true }
  ).lean();
  if (!doc) return sendError(res, 404, "MESSAGE_NOT_FOUND", "Community message not found");
  return sendSuccess(res, { id: String(doc._id), is_hidden: true }, "Message hidden");
}

async function deleteCommunity(req, res) {
  const messageId = String(req.params.id || "").trim();
  if (!messageId) return sendError(res, 400, "VALIDATION_ERROR", "Message id is required");
  const deleted = await CommunityMessage.findByIdAndDelete(messageId).lean();
  if (!deleted) return sendError(res, 404, "MESSAGE_NOT_FOUND", "Community message not found");
  return sendSuccess(res, { id: String(deleted._id), deleted: true }, "Message deleted");
}

async function postCommunity(req, res) {
  const bodySource = req.file ? req.body || {} : req.body || {};
  const schema = z.object({
    batch_id: z.string().min(1).trim().toLowerCase(),
    text: z.string().optional().default(""),
    code: z
      .object({
        lang: z.string().optional(),
        content: z.string().optional(),
      })
      .optional(),
  });
  const body = schema.parse(bodySource);
  const scope = await resolveDoubtScope(req);
  if (!(await staffCanAccessBatch(scope, body.batch_id))) {
    return sendError(res, 403, "FORBIDDEN", "You can only post in your assigned batches");
  }
  const text = String(body.text || "").trim();
  const codeContent = String(body.code?.content || "").trim();
  let media = null;
  if (req.file) {
    if (!isCloudinaryConfigured()) {
      return sendError(
        res,
        503,
        "CLOUDINARY_NOT_CONFIGURED",
        "Community media upload requires Cloudinary configuration"
      );
    }
    media = await uploadCommunityMedia(req);
  }
  if (!text && !codeContent && !media?.url) {
    return sendError(res, 400, "VALIDATION_ERROR", "Provide text, code, or media");
  }
  const staff = await Staff.findById(req.staff.sub).select("name role").lean();
  const created = await CommunityMessage.create({
    channel_id: body.batch_id,
    student_id: null,
    staff_id: req.staff.sub,
    author_role: staff?.role || "instructor",
    author_name: staff?.name || "Instructor",
    text,
    code: codeContent ? { lang: body.code?.lang || "text", content: codeContent } : undefined,
    media: media?.url ? media : undefined,
    likes: [],
  });
  return sendSuccess(
    res,
    {
      id: String(created._id),
      channel_id: created.channel_id,
      media: created.media || null,
    },
    "Posted"
  );
}

module.exports = { listPersonal, answerPersonal, listCommunity, postCommunity, hideCommunity, deleteCommunity };
