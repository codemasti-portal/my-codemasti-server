const { sendSuccess, sendError } = require("../utils/response");
const { z } = require("zod");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const Student = require("../models/Student");
const Notification = require("../models/Notification");

async function listConversations(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const skip = (page - 1) * limit;
  const search = String(req.query.search || "").trim().toLowerCase();

  const [rows, total] = await Promise.all([
    SupportConversation.find({})
      .sort({ last_message_at: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupportConversation.countDocuments({}),
  ]);

  const studentIds = [...new Set(rows.map((r) => String(r.student_id)).filter(Boolean))];
  const students = await Student.find({ _id: { $in: studentIds } })
    .select("name email enrollment_number batch batch_id section_id course phone_number student_phone whatsapp_number")
    .lean();
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  const convIds = rows.map((r) => r._id);
  const latestRows = convIds.length
    ? await SupportMessage.aggregate([
        { $match: { conversation_id: { $in: convIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$conversation_id", row: { $first: "$$ROOT" } } },
      ])
    : [];
  const latestByConversationId = new Map(latestRows.map((r) => [String(r._id), r.row]));

  const data = rows
    .map((c) => {
      const s = studentById.get(String(c.student_id));
      const latest = latestByConversationId.get(String(c._id));
      return {
        conversation_id: String(c._id),
        status: c.status,
        admin_status: c.admin_status || "pending",
        admin_status_updated_at: c.admin_status_updated_at || c.updatedAt || c.createdAt,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        last_message_at: c.last_message_at || c.updatedAt || c.createdAt,
        student: s
          ? {
              id: String(s._id),
              name: s.name || "",
              email: s.email || "",
              enrollment_number: s.enrollment_number || "",
              batch: s.batch || "",
              batch_id: s.batch_id || "",
              section_id: s.section_id || "",
              course: s.course || "",
              phone_number: s.phone_number || "",
              student_phone: s.student_phone || "",
              whatsapp_number: s.whatsapp_number || "",
            }
          : null,
        latest_message: latest
          ? {
              from: latest.from || "",
              text: latest.text || "",
              admin_status: latest.from === "student" ? latest.admin_status || "pending" : undefined,
              media: latest.media?.url ? latest.media : null,
              created_at: latest.createdAt || null,
            }
          : null,
      };
    })
    .filter((row) => {
      if (!search) return true;
      const hay = [
        row.student?.name,
        row.student?.email,
        row.student?.enrollment_number,
        row.student?.batch,
        row.student?.batch_id,
        row.latest_message?.text,
      ]
        .map((x) => String(x || "").toLowerCase())
        .join(" ");
      return hay.includes(search);
    });

  return sendSuccess(res, data, "", { page, limit, total });
}

async function getConversationMessages(req, res) {
  const conversationId = req.params.conversationId;
  const conv = await SupportConversation.findById(conversationId).lean();
  if (!conv) return sendError(res, 404, "CONVERSATION_NOT_FOUND", "Support conversation not found");

  const student = await Student.findById(conv.student_id)
    .select("name email enrollment_number batch batch_id section_id course phone_number student_phone whatsapp_number")
    .lean();

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    SupportMessage.find({ conversation_id: conv._id })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupportMessage.countDocuments({ conversation_id: conv._id }),
  ]);

  return sendSuccess(
    res,
    {
      conversation: {
        conversation_id: String(conv._id),
        status: conv.status,
        created_at: conv.createdAt,
        updated_at: conv.updatedAt,
        last_message_at: conv.last_message_at || conv.updatedAt || conv.createdAt,
      },
      student: student
        ? {
            id: String(student._id),
            name: student.name || "",
            email: student.email || "",
            enrollment_number: student.enrollment_number || "",
            batch: student.batch || "",
            batch_id: student.batch_id || "",
            section_id: student.section_id || "",
            course: student.course || "",
            phone_number: student.phone_number || "",
            student_phone: student.student_phone || "",
            whatsapp_number: student.whatsapp_number || "",
          }
        : null,
      messages: rows.map((m) => ({
        id: String(m._id),
        from: m.from,
        text: m.text,
        admin_status: m.from === "student" ? m.admin_status || "pending" : undefined,
        admin_status_updated_at: m.from === "student" ? m.admin_status_updated_at || m.updatedAt || m.createdAt : undefined,
        media: m.media?.url ? m.media : null,
        created_at: m.createdAt,
      })),
    },
    "",
    { page, limit, total }
  );
}

async function updateMessageStatus(req, res) {
  const schema = z.object({
    admin_status: z.enum(["pending", "ongoing", "resolved"]),
  });
  const body = schema.parse(req.body || {});
  const msg = await SupportMessage.findById(req.params.messageId);
  if (!msg) return sendError(res, 404, "MESSAGE_NOT_FOUND", "Support message not found");
  if (msg.from !== "student") {
    return sendError(res, 400, "VALIDATION_ERROR", "Only student messages can be status-updated");
  }
  msg.admin_status = body.admin_status;
  msg.admin_status_updated_at = new Date();
  await msg.save();

  const conv = await SupportConversation.findById(msg.conversation_id).select("student_id").lean();
  if (!conv) return sendError(res, 404, "CONVERSATION_NOT_FOUND", "Support conversation not found");

  const statusLabel =
    body.admin_status === "resolved" ? "Resolved" : body.admin_status === "ongoing" ? "On Work" : "Sent";
  await Notification.create({
    student_id: conv.student_id,
    type: "system",
    title: "Support message status updated",
    body: `One of your support messages is now marked as ${statusLabel}.`,
    read_at: null,
    ref_id: `support:${String(conv._id)}:message:${String(msg._id)}:status`,
  });

  return sendSuccess(
    res,
    {
      message_id: String(msg._id),
      conversation_id: String(msg.conversation_id),
      admin_status: msg.admin_status,
      admin_status_updated_at: msg.admin_status_updated_at,
    },
    "Status updated"
  );
}

module.exports = { listConversations, getConversationMessages, updateMessageStatus };
