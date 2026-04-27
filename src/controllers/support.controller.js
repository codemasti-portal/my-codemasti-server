const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const Student = require("../models/Student");
const { sendSimpleEmail } = require("../services/brevo");
const staffPanelNotifications = require("../services/staffPanelNotification.service");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildCommunityUploadFolder,
} = require("../utils/cloudinary");

const ALLOWED_SUPPORT_RECIPIENTS = [
  "support@codemasti.com",
  "admin@codemsati.com",
  "info.codemasti@gmail.com",
];
const DEFAULT_SUPPORT_RECIPIENT = "info.codemasti@gmail.com";

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

function parseRecipientEmails(rawValue) {
  if (Array.isArray(rawValue)) return rawValue;
  if (typeof rawValue !== "string") return undefined;
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function getSupportRecipientEmails(selectedEmails) {
  const raw = Array.isArray(selectedEmails) ? selectedEmails : [];
  const normalized = raw
    .map((email) => String(email || "").trim().toLowerCase())
    .filter((email) => ALLOWED_SUPPORT_RECIPIENTS.includes(email));
  const unique = [...new Set(normalized)];
  return unique.length ? unique : [DEFAULT_SUPPORT_RECIPIENT];
}

async function notifySupportInbox({ student, conversationId, text, recipientEmails, media }) {
  const toEmails = getSupportRecipientEmails(recipientEmails);
  if (!toEmails.length) return;

  const studentName = String(student?.name || "Student").trim();
  const studentEmail = String(student?.email || "N/A").trim();
  const studentEnrollment = String(student?.enrollment_number || "N/A").trim();
  const trimmedText = String(text || "").trim();
  const mediaUrl = String(media?.url || "").trim();
  const mediaName = String(media?.file_name || "").trim();
  const mediaType = String(media?.mime_type || "").trim();

  const subject = `New support message from ${studentName}`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111;">
      <h2 style="margin:0 0 12px;">New student support message</h2>
      <ul>
        <li><strong>Student:</strong> ${studentName}</li>
        <li><strong>Email:</strong> ${studentEmail}</li>
        <li><strong>Enrollment:</strong> ${studentEnrollment}</li>
        <li><strong>Conversation ID:</strong> ${conversationId}</li>
      </ul>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;">${trimmedText}</p>
      ${
        mediaUrl
          ? `<p><strong>Attachment:</strong> <a href="${mediaUrl}" target="_blank" rel="noreferrer">${mediaName || mediaUrl}</a>${
              mediaType ? ` (${mediaType})` : ""
            }</p>`
          : ""
      }
    </div>
  `.trim();
  const textContent = [
    "New student support message",
    `Student: ${studentName}`,
    `Email: ${studentEmail}`,
    `Enrollment: ${studentEnrollment}`,
    `Conversation ID: ${conversationId}`,
    "",
    "Message:",
    trimmedText,
    ...(mediaUrl ? ["", `Attachment: ${mediaName || mediaUrl}`, `Link: ${mediaUrl}`, `Type: ${mediaType || "N/A"}`] : []),
  ].join("\n");

  try {
    for (const toEmail of toEmails) {
      await sendSimpleEmail({ toEmail, subject, htmlContent, textContent });
    }
  } catch (err) {
    console.error("[SUPPORT_EMAIL_SEND_FAILED]", err?.message || err);
  }
}

async function openOrResumeConversation(req, res) {
  let conv = await SupportConversation.findOne({ student_id: req.user.sub, status: "open" });
  if (!conv) {
    conv = await SupportConversation.create({
      student_id: req.user.sub,
      status: "open",
      last_message_at: new Date(),
    });
  }
  return sendSuccess(res, {
    conversation_id: String(conv._id),
  });
}

async function sendMessage(req, res) {
  const schema = z.object({
    text: z.string().optional().default(""),
    recipient_emails: z
      .array(z.enum(ALLOWED_SUPPORT_RECIPIENTS))
      .min(1)
      .max(ALLOWED_SUPPORT_RECIPIENTS.length)
      .optional()
      .default([DEFAULT_SUPPORT_RECIPIENT]),
  });
  const body = schema.parse({
    text: req.body?.text,
    recipient_emails: parseRecipientEmails(req.body?.recipient_emails),
  });
  const conv = await SupportConversation.findOne({
    _id: req.params.conversationId,
    student_id: req.user.sub,
  });
  if (!conv) return sendError(res, 404, "CONVERSATION_NOT_FOUND", "Conversation not found");

  let media;
  if (req.file) {
    if (!isCloudinaryConfigured()) {
      return sendError(
        res,
        503,
        "CLOUDINARY_NOT_CONFIGURED",
        "Media upload requires Cloudinary configuration"
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

  const text = String(body.text || "").trim();
  if (!text && !media?.url) {
    return sendError(res, 400, "VALIDATION_ERROR", "Provide text or media");
  }

  const msg = await SupportMessage.create({
    conversation_id: conv._id,
    from: "student",
    text,
    admin_status: "pending",
    admin_status_updated_at: new Date(),
    media: media?.url ? media : undefined,
  });
  conv.last_message_at = new Date();
  await conv.save();

  const student = await Student.findById(req.user.sub).select("name email enrollment_number").lean();
  await notifySupportInbox({
    student,
    conversationId: String(conv._id),
    text,
    recipientEmails: body.recipient_emails,
    media,
  });

  await staffPanelNotifications.emitEventNotification({
    title: "New support message",
    message: `${student?.name || "A student"} sent a support message${text ? `: ${text.slice(0, 120)}` : " with attachment"}.`,
    category: "alerts",
    audience: "role",
    target_roles: ["super_admin", "admin"],
    event_type: "support_message_created",
  });

  return sendSuccess(res, { message_id: String(msg._id), created_at: msg.createdAt });
}

async function listMessages(req, res) {
  const conv = await SupportConversation.findOne({
    _id: req.params.conversationId,
    student_id: req.user.sub,
  }).lean();
  if (!conv) return sendError(res, 404, "CONVERSATION_NOT_FOUND", "Conversation not found");

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    SupportMessage.find({ conversation_id: conv._id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupportMessage.countDocuments({ conversation_id: conv._id }),
  ]);

  const data = rows.map((m) => ({
    id: String(m._id),
    from: m.from,
    text: m.text,
    admin_status: m.from === "student" ? m.admin_status || "pending" : undefined,
    admin_status_updated_at: m.from === "student" ? m.admin_status_updated_at || m.updatedAt || m.createdAt : undefined,
    media: m.media?.url ? m.media : null,
    created_at: m.createdAt,
  }));

  return sendSuccess(res, data, "", { page, limit, total });
}

module.exports = { openOrResumeConversation, sendMessage, listMessages };
