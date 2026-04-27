const { z } = require("zod");
const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const StaffPanelNotification = require("../models/StaffPanelNotification");
const StaffPanelNotificationState = require("../models/StaffPanelNotificationState");
const Staff = require("../models/Staff");
const Student = require("../models/Student");
const Notification = require("../models/Notification");
const StudentBroadcastLog = require("../models/StudentBroadcastLog");
const svc = require("../services/staffPanelNotification.service");

const INSERT_CHUNK = 500;

const ROLE_ENUM = z.enum(["super_admin", "admin", "instructor", "mentor"]);
const AUDIENCE_ENUM = z.enum(["global", "role", "individual"]);
const CATEGORY_ENUM = z.enum(["updates", "alerts", "assignments", "system"]);

function staffSub(req) {
  return String(req.staff?.sub || "");
}

function staffRole(req) {
  return String(req.staff?.role || "");
}

async function listMine(req, res) {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 30)));
  const skip = Math.max(0, Number(req.query.skip || 0));
  const data = await svc.listVisibleForStaff(staffSub(req), staffRole(req), { limit, skip });
  return sendSuccess(res, data, "", { total: data.length });
}

async function unreadCount(req, res) {
  const count = await svc.unreadCount(staffSub(req), staffRole(req));
  return sendSuccess(res, { count });
}

async function postReadOne(req, res) {
  const id = req.params.id;
  const ok = await svc.assertStaffCanAccessNotification(staffSub(req), staffRole(req), id);
  if (!ok) return sendError(res, 404, "NOT_FOUND", "Notification not found");
  await svc.markRead(staffSub(req), id);
  return sendSuccess(res, { id, read: true });
}

async function postMarkAllRead(req, res) {
  await svc.markAllRead(staffSub(req), staffRole(req));
  return sendSuccess(res, {}, "Marked all as read");
}

async function postClearAll(req, res) {
  await svc.clearAll(staffSub(req), staffRole(req));
  return sendSuccess(res, {}, "Cleared");
}

const createSchema = z.object({
  title: z.string().min(2).max(200).trim(),
  message: z.string().min(1).max(4000).trim(),
  category: CATEGORY_ENUM.optional().default("updates"),
  audience: AUDIENCE_ENUM,
  target_roles: z.array(ROLE_ENUM).optional().default([]),
  recipient_id: z.string().optional(),
});

async function adminCreate(req, res) {
  const body = createSchema.parse(req.body);
  if (body.audience === "role" && (!body.target_roles || body.target_roles.length === 0)) {
    return sendError(res, 400, "VALIDATION_ERROR", "target_roles is required for role audience");
  }
  if (body.audience === "individual") {
    const rid = String(body.recipient_id || "").trim();
    if (!mongoose.isValidObjectId(rid)) {
      return sendError(res, 400, "VALIDATION_ERROR", "recipient_id is required for individual audience");
    }
    const exists = await Staff.findById(rid).select("_id").lean();
    if (!exists) return sendError(res, 400, "VALIDATION_ERROR", "Recipient staff not found");
  }
  const doc = await svc.createNotification({
    title: body.title,
    message: body.message,
    category: body.category,
    audience: body.audience,
    target_roles: body.audience === "role" ? body.target_roles : [],
    recipient_id: body.audience === "individual" ? body.recipient_id : null,
    source: "manual",
    created_by: staffSub(req),
  });
  const o = doc.toObject ? doc.toObject() : doc;
  return sendSuccess(
    res,
    {
      id: String(o._id),
      title: o.title,
      message: o.message,
      category: o.category,
      audience: o.audience,
      target_roles: o.target_roles || [],
      recipient_id: o.recipient_id ? String(o.recipient_id) : "",
      created_at: o.createdAt,
    },
    "Notification created"
  );
}

async function adminList(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    StaffPanelNotification.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    StaffPanelNotification.countDocuments({}),
  ]);
  const data = items.map((row) => ({
    id: String(row._id),
    title: row.title,
    message: row.message,
    category: row.category,
    audience: row.audience,
    target_roles: row.target_roles || [],
    recipient_id: row.recipient_id ? String(row.recipient_id) : "",
    source: row.source,
    event_type: row.event_type || "",
    created_by: row.created_by ? String(row.created_by) : "",
    created_at: row.createdAt,
  }));
  return sendSuccess(res, data, "", { page, limit, total });
}

const patchSchema = z.object({
  title: z.string().min(2).max(200).trim().optional(),
  message: z.string().min(1).max(4000).trim().optional(),
  category: CATEGORY_ENUM.optional(),
});

async function adminPatch(req, res) {
  const body = patchSchema.parse(req.body);
  const doc = await StaffPanelNotification.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Notification not found");
  if (body.title !== undefined) doc.title = body.title;
  if (body.message !== undefined) doc.message = body.message;
  if (body.category !== undefined) doc.category = body.category;
  await doc.save();
  const o = doc.toObject();
  return sendSuccess(res, {
    id: String(o._id),
    title: o.title,
    message: o.message,
    category: o.category,
    audience: o.audience,
    created_at: o.createdAt,
  });
}

async function adminDelete(req, res) {
  const r = await StaffPanelNotification.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Notification not found");
  await StaffPanelNotificationState.deleteMany({ notification_id: req.params.id });
  return sendSuccess(res, { id: req.params.id }, "Deleted");
}

const studentBroadcastSchema = z.object({
  title: z.string().min(2).max(200).trim(),
  message: z.string().min(1).max(4000).trim(),
});

/**
 * Fan-out one in-app notification per student (existing student /v1/notifications API).
 * ref_id stores the broadcast log id for traceability.
 */
async function studentBroadcastCreate(req, res) {
  const body = studentBroadcastSchema.parse(req.body);
  const students = await Student.find({ role: "student" }).select("_id").lean();
  const recipientCount = students.length;

  const log = await StudentBroadcastLog.create({
    title: body.title,
    message: body.message,
    recipient_count: recipientCount,
    created_by: staffSub(req) || null,
  });
  const refId = String(log._id);

  const docs = students.map((s) => ({
    student_id: s._id,
    type: "system",
    title: body.title,
    body: body.message,
    read_at: null,
    ref_id: refId,
  }));

  for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
    const slice = docs.slice(i, i + INSERT_CHUNK);
    if (slice.length) await Notification.insertMany(slice, { ordered: false });
  }

  return sendSuccess(
    res,
    {
      id: refId,
      recipient_count: recipientCount,
      title: body.title,
    },
    recipientCount
      ? `Sent to ${recipientCount} student${recipientCount === 1 ? "" : "s"}`
      : "No student accounts — log entry created only"
  );
}

async function studentBroadcastList(req, res) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    StudentBroadcastLog.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    StudentBroadcastLog.countDocuments({}),
  ]);
  const data = rows.map((row) => ({
    id: String(row._id),
    title: row.title,
    message: row.message,
    recipient_count: row.recipient_count,
    created_by: row.created_by ? String(row.created_by) : "",
    created_at: row.createdAt,
  }));
  return sendSuccess(res, data, "", { page, limit, total });
}

module.exports = {
  listMine,
  unreadCount,
  postReadOne,
  postMarkAllRead,
  postClearAll,
  adminCreate,
  adminList,
  adminPatch,
  adminDelete,
  studentBroadcastCreate,
  studentBroadcastList,
};
