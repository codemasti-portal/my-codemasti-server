const Notification = require("../models/Notification");
const StaffPanelNotification = require("../models/StaffPanelNotification");

const DAY_MS = 24 * 60 * 60 * 1000;

function daysToMs(days, fallback) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n * DAY_MS;
}

async function runNotificationCleanupOnce() {
  const now = Date.now();

  // Student notifications:
  // - Delete read notifications after STUDENT_NOTIF_DELETE_READ_AFTER_DAYS (default 30)
  // - Delete unread notifications after STUDENT_NOTIF_DELETE_UNREAD_AFTER_DAYS (default 120)
  const readCutoff = new Date(now - daysToMs(process.env.STUDENT_NOTIF_DELETE_READ_AFTER_DAYS, 30 * DAY_MS));
  const unreadCutoff = new Date(now - daysToMs(process.env.STUDENT_NOTIF_DELETE_UNREAD_AFTER_DAYS, 120 * DAY_MS));

  const r1 = await Notification.deleteMany({ read_at: { $ne: null, $lte: readCutoff } });
  const r2 = await Notification.deleteMany({ read_at: null, createdAt: { $lte: unreadCutoff } });

  // Staff panel notifications:
  // Delete after STAFF_NOTIF_DELETE_AFTER_DAYS (default 180)
  const staffCutoff = new Date(now - daysToMs(process.env.STAFF_NOTIF_DELETE_AFTER_DAYS, 180 * DAY_MS));
  const r3 = await StaffPanelNotification.deleteMany({ createdAt: { $lte: staffCutoff } });

  return {
    student_read_deleted: r1.deletedCount || 0,
    student_unread_deleted: r2.deletedCount || 0,
    staff_deleted: r3.deletedCount || 0,
  };
}

function startNotificationCleanupScheduler() {
  // Run once at boot, then every 24 hours.
  const run = async () => {
    try {
      const res = await runNotificationCleanupOnce();
      if ((res.student_read_deleted || 0) + (res.student_unread_deleted || 0) + (res.staff_deleted || 0) > 0) {
        console.log("[NOTIFICATION_CLEANUP]", res);
      }
    } catch (e) {
      console.error("[NOTIFICATION_CLEANUP_FAILED]", e?.message || e);
    }
  };

  run();
  const timer = setInterval(run, DAY_MS);
  return timer;
}

module.exports = { startNotificationCleanupScheduler, runNotificationCleanupOnce };

