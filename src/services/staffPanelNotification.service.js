const mongoose = require("mongoose");
const StaffPanelNotification = require("../models/StaffPanelNotification");
const StaffPanelNotificationState = require("../models/StaffPanelNotificationState");

function toObjectId(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

/** Mongo filter: notifications visible to this staff member (server-side only). */
function visibilityFilter(staffId, staffRole) {
  const sid = toObjectId(staffId);
  const role = String(staffRole || "").trim();
  if (!sid || !role) return { _id: null };
  return {
    $or: [
      { audience: "individual", recipient_id: sid },
      { audience: "role", target_roles: role },
      { audience: "global" },
    ],
  };
}

async function createNotification(payload) {
  const doc = await StaffPanelNotification.create({
    title: payload.title,
    message: payload.message,
    category: payload.category || "updates",
    audience: payload.audience,
    target_roles: Array.isArray(payload.target_roles) ? payload.target_roles.map((r) => String(r).trim()) : [],
    recipient_id: payload.recipient_id ? toObjectId(payload.recipient_id) : null,
    source: payload.source || "manual",
    event_type: payload.event_type || "",
    action_url: String(payload.action_url || "").trim(),
    dedupe_key: String(payload.dedupe_key || "").trim(),
    created_by: payload.created_by ? toObjectId(payload.created_by) : null,
  });
  return doc;
}

/**
 * Event-triggered notifications (non-blocking for callers — log errors only).
 * @returns {Promise<{ created: boolean, duplicate: boolean }>}
 *   - created: a new panel row was inserted
 *   - duplicate: dedupe_key conflict (event already recorded)
 *   - neither true: unexpected persistence error (logged; not a duplicate)
 */
async function emitEventNotification(payload) {
  try {
    await createNotification({
      title: payload.title,
      message: payload.message,
      category: payload.category || "system",
      audience: payload.audience,
      target_roles: payload.target_roles || [],
      recipient_id: payload.recipient_id,
      source: "event",
      event_type: payload.event_type || "",
      action_url: payload.action_url || "",
      dedupe_key: payload.dedupe_key || "",
      created_by: payload.created_by || null,
    });
    return { created: true, duplicate: false };
  } catch (e) {
    if (e && (e.code === 11000 || String(e.message || "").includes("E11000"))) {
      return { created: false, duplicate: true };
    }
    console.warn("[StaffPanelNotification]", e.message || e);
    return { created: false, duplicate: false };
  }
}

async function listVisibleForStaff(staffId, staffRole, { limit = 40, skip = 0 } = {}) {
  const filter = visibilityFilter(staffId, staffRole);
  const items = await StaffPanelNotification.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Math.min(100, limit))
    .lean();

  const ids = items.map((i) => i._id);
  if (!ids.length) return [];

  const states = await StaffPanelNotificationState.find({
    staff_id: toObjectId(staffId),
    notification_id: { $in: ids },
  }).lean();
  const stateByNid = new Map(states.map((s) => [String(s.notification_id), s]));

  return items
    .filter((row) => {
      const st = stateByNid.get(String(row._id));
      return !st?.dismissed_at;
    })
    .map((row) => {
      const st = stateByNid.get(String(row._id));
      const read = Boolean(st?.read_at);
      return {
        id: String(row._id),
        title: row.title,
        message: row.message,
        category: row.category,
        audience: row.audience,
        read,
        created_at: row.createdAt,
        source: row.source,
        event_type: row.event_type,
        action_url: row.action_url || "",
      };
    });
}

async function unreadCount(staffId, staffRole) {
  const filter = visibilityFilter(staffId, staffRole);
  const items = await StaffPanelNotification.find(filter).select("_id").limit(500).lean();
  if (!items.length) return 0;
  const ids = items.map((i) => i._id);
  const states = await StaffPanelNotificationState.find({
    staff_id: toObjectId(staffId),
    notification_id: { $in: ids },
  }).lean();
  const stateByNid = new Map(states.map((s) => [String(s.notification_id), s]));
  let n = 0;
  for (const row of items) {
    const st = stateByNid.get(String(row._id));
    if (st?.dismissed_at) continue;
    if (st?.read_at) continue;
    n += 1;
  }
  return n;
}

async function markRead(staffId, notificationId) {
  const sid = toObjectId(staffId);
  const nid = toObjectId(notificationId);
  if (!sid || !nid) return null;
  await StaffPanelNotificationState.findOneAndUpdate(
    { notification_id: nid, staff_id: sid },
    { $set: { read_at: new Date(), dismissed_at: null } },
    { upsert: true, new: true }
  );
  return true;
}

async function markAllRead(staffId, staffRole) {
  const filter = visibilityFilter(staffId, staffRole);
  const items = await StaffPanelNotification.find(filter).select("_id").limit(500).lean();
  const sid = toObjectId(staffId);
  const now = new Date();
  for (const row of items) {
    await StaffPanelNotificationState.findOneAndUpdate(
      { notification_id: row._id, staff_id: sid },
      { $set: { read_at: now, dismissed_at: null } },
      { upsert: true }
    );
  }
}

async function clearAll(staffId, staffRole) {
  const filter = visibilityFilter(staffId, staffRole);
  const items = await StaffPanelNotification.find(filter).select("_id").limit(500).lean();
  const sid = toObjectId(staffId);
  const now = new Date();
  for (const row of items) {
    await StaffPanelNotificationState.findOneAndUpdate(
      { notification_id: row._id, staff_id: sid },
      { $set: { dismissed_at: now, read_at: now } },
      { upsert: true }
    );
  }
}

/** Ensure caller may access this notification (same visibility rules). */
async function assertStaffCanAccessNotification(staffId, staffRole, notificationId) {
  const nid = toObjectId(notificationId);
  if (!nid) return false;
  const doc = await StaffPanelNotification.findById(nid).lean();
  if (!doc) return false;
  const filter = visibilityFilter(staffId, staffRole);
  const check = await StaffPanelNotification.findOne({ _id: nid, ...filter }).lean();
  return Boolean(check);
}

module.exports = {
  visibilityFilter,
  createNotification,
  emitEventNotification,
  listVisibleForStaff,
  unreadCount,
  markRead,
  markAllRead,
  clearAll,
  assertStaffCanAccessNotification,
  toObjectId,
};
