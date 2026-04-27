const { sendSuccess, sendError } = require("../utils/response");
const Notification = require("../models/Notification");

async function list(req, res) {
  const type = String(req.query.type || "").trim();
  const unreadOnly = String(req.query.unread_only || "false").toLowerCase() === "true";

  const filter = { student_id: req.user.sub };
  if (type === "announcement" || type === "system") filter.type = type;
  if (unreadOnly) filter.read_at = null;

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);

  const data = rows.map((n) => ({
    id: String(n._id),
    type: n.type,
    title: n.title,
    body: n.body,
    read: Boolean(n.read_at),
    ref_id: n.ref_id,
    created_at: n.createdAt,
  }));

  return sendSuccess(res, data, "", { page, limit, total });
}

async function markRead(req, res) {
  const n = await Notification.findOne({ _id: req.params.id, student_id: req.user.sub });
  if (!n) return sendError(res, 404, "NOTIFICATION_NOT_FOUND", "Notification not found");
  n.read_at = new Date();
  await n.save();
  return sendSuccess(res, { id: String(n._id), read: true });
}

module.exports = { list, markRead };
