const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const AdminTodoTask = require("../models/AdminTodoTask");

const createSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(4000).optional().default(""),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(4000).optional(),
  status: z.enum(["pending", "in_progress", "resolved"]).optional(),
});

function toRow(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    description: doc.description || "",
    status: doc.status,
    resolved_at: doc.resolved_at || null,
    created_by: doc.created_by ? String(doc.created_by) : "",
    updated_by: doc.updated_by ? String(doc.updated_by) : "",
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

async function listTasks(req, res) {
  const status = String(req.query.status || "").trim().toLowerCase();
  const filter = {};
  if (["pending", "in_progress", "resolved"].includes(status)) filter.status = status;
  const rows = await AdminTodoTask.find(filter).sort({ status: 1, createdAt: -1 }).limit(500).lean();
  return sendSuccess(res, rows.map(toRow));
}

async function createTask(req, res) {
  const body = createSchema.parse(req.body || {});
  const created = await AdminTodoTask.create({
    title: body.title,
    description: body.description || "",
    status: "pending",
    resolved_at: null,
    created_by: req.staff.sub,
    updated_by: req.staff.sub,
  });
  return sendSuccess(res, toRow(created.toObject()), "Task created");
}

async function updateTask(req, res) {
  const body = patchSchema.parse(req.body || {});
  const doc = await AdminTodoTask.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Task not found");
  if (body.title !== undefined) doc.title = body.title;
  if (body.description !== undefined) doc.description = body.description;
  if (body.status !== undefined) {
    doc.status = body.status;
    doc.resolved_at = body.status === "resolved" ? new Date() : null;
  }
  doc.updated_by = req.staff.sub;
  await doc.save();
  return sendSuccess(res, toRow(doc.toObject()), "Task updated");
}

async function deleteTask(req, res) {
  const r = await AdminTodoTask.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Task not found");
  return sendSuccess(res, { id: req.params.id }, "Task deleted");
}

module.exports = { listTasks, createTask, updateTask, deleteTask };
