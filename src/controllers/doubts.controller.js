const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const PersonalDoubt = require("../models/PersonalDoubt");
const CommunityMessage = require("../models/CommunityMessage");
const Student = require("../models/Student");
const BatchCatalog = require("../models/BatchCatalog");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildCommunityUploadFolder,
  buildDoubtsUploadFolder,
} = require("../utils/cloudinary");

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

async function createPersonal(req, res) {
  const schema = z.object({
    subject: z.string().min(1),
    title: z.string().min(2),
    description: z.string().optional().default(""),
    code: z.string().optional().default(""),
  });
  const body = schema.parse({
    subject: req.body.subject,
    title: req.body.title,
    description: req.body.description,
    code: req.body.code,
  });

  let image_url = "";
  if (req.file?.buffer) {
    if (!isCloudinaryConfigured()) {
      return sendError(
        res,
        503,
        "CLOUDINARY_NOT_CONFIGURED",
        "Doubt image upload requires Cloudinary configuration"
      );
    }
    const folder = buildDoubtsUploadFolder("image");
    const result = await uploadBufferToFolder(req.file.buffer, "image", folder, {
      filenameOverride: req.file.originalname || "",
    });
    image_url = result.secure_url || result.url || "";
  }

  const doc = await PersonalDoubt.create({
    student_id: req.user.sub,
    subject: body.subject.trim(),
    title: body.title.trim(),
    description: body.description,
    code: body.code,
    image_url,
    status: "pending",
    unread_by_student: false,
  });

  return sendSuccess(
    res,
    {
      id: String(doc._id),
      status: doc.status,
      image_url: doc.image_url,
    },
    "Doubt submitted"
  );
}

async function listSubjects(req, res) {
  const student = await Student.findById(req.user.sub).select("batch_id section_id").lean();
  const batchId = String(student?.batch_id || "").trim().toLowerCase();
  const sectionId = String(student?.section_id || "").trim().toLowerCase();
  if (!batchId) return sendSuccess(res, []);

  const batch = await BatchCatalog.findOne({ batch_id: batchId }).lean();
  if (!batch) return sendSuccess(res, []);

  const sections = Array.isArray(batch.sections) ? batch.sections : [];
  const subjectSet = new Set();
  for (const section of sections) {
    const sid = String(section?.section_id || "").trim().toLowerCase();
    if (sectionId && sid && sid !== sectionId) continue;
    for (const subject of section?.subjects || []) {
      const s = String(subject || "").trim();
      if (s) subjectSet.add(s);
    }
  }

  return sendSuccess(res, [...subjectSet].sort((a, b) => a.localeCompare(b)));
}

async function listPersonal(req, res) {
  const status = String(req.query.status || "").trim();
  const filter = { student_id: req.user.sub };
  if (status === "pending" || status === "answered") filter.status = status;

  const rows = await PersonalDoubt.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const data = rows.map((d) => ({
    id: String(d._id),
    subject: d.subject,
    title: d.title,
    description: d.description,
    code: d.code,
    image_url: d.image_url,
    status: d.status,
    teacher_name: d.teacher_name,
    teacher_reply: d.teacher_reply,
    teacher_reply_code: d.teacher_reply_code || "",
    teacher_reply_image_url: d.teacher_reply_image_url || "",
    answered_at: d.answered_at,
    unread_by_student: d.unread_by_student,
    created_at: d.createdAt,
  }));
  return sendSuccess(res, data);
}

async function listCommunityMessages(req, res) {
  const student = await Student.findById(req.user.sub).select("batch_id").lean();
  const channelId = String(student?.batch_id || "").trim().toLowerCase();
  if (!channelId) return sendError(res, 400, "BATCH_REQUIRED", "Student batch is required for community doubts");
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const skip = (page - 1) * limit;

  const messageFilter = { channel_id: channelId, is_hidden: { $ne: true } };
  const [rows, total] = await Promise.all([
    CommunityMessage.find(messageFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CommunityMessage.countDocuments(messageFilter),
  ]);

  const data = rows.reverse().map((m) => ({
    id: String(m._id),
    channel_id: m.channel_id,
    is_mine: String(m.student_id) === String(req.user.sub),
    author_name: m.author_name,
    author_role: m.author_role || "student",
    text: m.text,
    code: m.code,
    media: m.media || null,
    likes: (m.likes || []).length,
    liked_by_me: (m.likes || []).some((id) => String(id) === String(req.user.sub)),
    created_at: m.createdAt,
  }));

  return sendSuccess(res, data, "", { page, limit, total });
}

async function postCommunityMessage(req, res) {
  const schema = z.object({
    text: z.string().optional().default(""),
    code: z
      .object({
        lang: z.string().optional(),
        content: z.string().optional(),
      })
      .optional(),
  });
  const raw = req.body || {};
  const body = schema.parse({
    ...raw,
    code:
      raw.code && typeof raw.code === "object"
        ? raw.code
        : raw["code[content]"]
          ? { lang: raw["code[lang]"] || "text", content: raw["code[content]"] }
          : undefined,
  });

  const student = await Student.findById(req.user.sub).select("name batch_id").lean();
  const channelId = String(student?.batch_id || "").trim().toLowerCase();
  if (!channelId) return sendError(res, 400, "BATCH_REQUIRED", "Student batch is required for community doubts");
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
    const resourceType = mediaResourceType(req.file.mimetype);
    const folder = buildCommunityUploadFolder(resourceType);
    const result = await uploadBufferToFolder(req.file.buffer, resourceType, folder, {
      filenameOverride: req.file.originalname || "",
    });
    media = {
      url: result.secure_url || result.url,
      mime_type: req.file.mimetype || "",
      file_name: req.file.originalname || "",
      bytes: Number(result.bytes || req.file.size || 0),
      kind: mediaKindFromResourceType(resourceType),
    };
  }

  if (!text && !codeContent && !media?.url) {
    return sendError(res, 400, "VALIDATION_ERROR", "Provide text, code, or media");
  }

  const msg = await CommunityMessage.create({
    channel_id: channelId,
    student_id: req.user.sub,
    staff_id: null,
    author_role: "student",
    author_name: student?.name || "Student",
    text,
    code: codeContent ? { lang: body.code?.lang || "text", content: codeContent } : undefined,
    media: media?.url ? media : undefined,
    likes: [],
  });

  return sendSuccess(
    res,
    {
      id: String(msg._id),
      channel_id: msg.channel_id,
      created_at: msg.createdAt,
    },
    "Message posted"
  );
}

async function likeCommunityMessage(req, res) {
  const msg = await CommunityMessage.findByIdAndUpdate(
    req.params.messageId,
    { $addToSet: { likes: req.user.sub } },
    { new: true }
  ).lean();
  if (!msg) return sendError(res, 404, "MESSAGE_NOT_FOUND", "Message not found");

  return sendSuccess(res, { likes: (msg.likes || []).length, liked: true });
}

module.exports = {
  createPersonal,
  listSubjects,
  listPersonal,
  listCommunityMessages,
  postCommunityMessage,
  likeCommunityMessage,
};
