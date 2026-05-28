const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const AdminTodoTask = require("../models/AdminTodoTask");

const createSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(4000).optional().default(""),
  priority: z.enum(["low", "mid", "high"]).optional().default("low"),
  order: z.number().optional().default(0),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(4000).optional(),
  status: z.enum(["pending", "in_progress", "resolved"]).optional(),
  priority: z.enum(["low", "mid", "high"]).optional(),
  order: z.number().optional(),
});

function toRow(doc) {
  const createdBy = doc.created_by;
  const updatedBy = doc.updated_by;
  const isCreatedByPopulated = createdBy && typeof createdBy === "object" && createdBy._id;
  const isUpdatedByPopulated = updatedBy && typeof updatedBy === "object" && updatedBy._id;
  return {
    id: String(doc._id),
    title: doc.title,
    description: doc.description || "",
    status: doc.status,
    priority: doc.priority,
    order: doc.order,
    resolved_at: doc.resolved_at || null,
    created_by: isCreatedByPopulated ? String(createdBy._id) : (createdBy ? String(createdBy) : ""),
    created_by_name: isCreatedByPopulated ? (createdBy.name || "") : "",
    updated_by: isUpdatedByPopulated ? String(updatedBy._id) : (updatedBy ? String(updatedBy) : ""),
    updated_by_name: isUpdatedByPopulated ? (updatedBy.name || "") : "",
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

function withStaffNames(query) {
  return query
    .populate({ path: "created_by", select: "name" })
    .populate({ path: "updated_by", select: "name" });
}

async function listTasks(req, res) {
  const status = String(req.query.status || "").trim().toLowerCase();
  const filter = {};
  if (["pending", "in_progress", "resolved"].includes(status)) filter.status = status;
  const rows = await withStaffNames(
    AdminTodoTask.find(filter).sort({ status: 1, order: 1, createdAt: -1 }).limit(500)
  ).lean();
  return sendSuccess(res, rows.map(toRow));
}

async function createTask(req, res) {
  const body = createSchema.parse(req.body || {});
  const created = await AdminTodoTask.create({
    title: body.title,
    description: body.description || "",
    status: "pending",
    priority: body.priority,
    order: body.order,
    resolved_at: null,
    created_by: req.staff.sub,
    updated_by: req.staff.sub,
  });
  await created.populate([
    { path: "created_by", select: "name" },
    { path: "updated_by", select: "name" },
  ]);
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
  if (body.priority !== undefined) doc.priority = body.priority;
  if (body.order !== undefined) doc.order = body.order;
  doc.updated_by = req.staff.sub;
  await doc.save();
  await doc.populate([
    { path: "created_by", select: "name" },
    { path: "updated_by", select: "name" },
  ]);
  return sendSuccess(res, toRow(doc.toObject()), "Task updated");
}

async function deleteTask(req, res) {
  const r = await AdminTodoTask.deleteOne({ _id: req.params.id });
  if (r.deletedCount === 0) return sendError(res, 404, "NOT_FOUND", "Task not found");
  return sendSuccess(res, { id: req.params.id }, "Task deleted");
}

const reorderSchema = z.object({
  updates: z.array(z.object({
    id: z.string(),
    status: z.enum(["pending", "in_progress", "resolved"]).optional(),
    priority: z.enum(["low", "mid", "high"]).optional(),
    order: z.number(),
  })),
});

async function reorderTasks(req, res) {
  const { updates } = reorderSchema.parse(req.body || {});

  const bulkOps = updates.map((update) => {
    const $set = { order: update.order, updated_by: req.staff.sub };
    if (update.priority !== undefined) $set.priority = update.priority;
    if (update.status !== undefined) {
      $set.status = update.status;
      $set.resolved_at = update.status === "resolved" ? new Date() : null;
    }
    return {
      updateOne: {
        filter: { _id: update.id },
        update: { $set },
      },
    };
  });

  if (bulkOps.length > 0) {
    await AdminTodoTask.bulkWrite(bulkOps);
  }

  return sendSuccess(res, null, "Tasks reordered");
}

module.exports = { listTasks, createTask, updateTask, deleteTask, reorderTasks };
