const { runReminderTick } = require("./timetable-class-reminder.scheduler");
const { runReminderTick: runMentorReminderTick } = require("./mentor-reminder.scheduler");
const { runMentorPublishSweepTick } = require("./mentor-notification.service");
const { runEventReminderTick } = require("./timetable-event-reminder.scheduler");
const {
  runTick: runAssignmentReleaseTick,
  backfillReleaseNotificationFlag,
} = require("./assignment-release-notification.scheduler");
const { runMonthlyInvoiceTick } = require("./monthly-invoice.scheduler");
const { runPostSessionTasksTick } = require("./post-session-tasks.scheduler");

/**
 * Runs the time-sensitive scheduler ticks once. Called by the external cron pinger
 * (every minute) via POST /v1/internal/cron/run, since in-process setInterval timers
 * don't run on Vercel's serverless functions (server.js's setInterval-based schedulers
 * are for traditional/local hosting only — they never fire in the Vercel deployment).
 *
 * Each tick is idempotent (atomic claim + *_sent_at markers), so running it late or
 * twice never produces duplicate emails. Ticks that only matter on a specific day/hour
 * (monthly invoices) self-gate internally and are cheap no-ops the rest of the time —
 * safe to include in this per-minute run without extra cost.
 *
 * NOT included here: notification-cleanup.scheduler (unconditional daily deleteMany —
 * would run every minute if wired in here; needs its own persisted last-run gate before
 * it's safe to add to a per-minute trigger).
 */
async function runScheduledTicks() {
  const results = {};
  try {
    await runReminderTick();
    results.classReminders = "ok";
  } catch (e) {
    results.classReminders = `error: ${e?.message || e}`;
  }
  try {
    await runMentorReminderTick();
    results.mentorReminders = "ok";
  } catch (e) {
    results.mentorReminders = `error: ${e?.message || e}`;
  }
  try {
    await runMentorPublishSweepTick();
    results.mentorPublishSweep = "ok";
  } catch (e) {
    results.mentorPublishSweep = `error: ${e?.message || e}`;
  }
  try {
    await runEventReminderTick();
    results.eventReminders = "ok";
  } catch (e) {
    results.eventReminders = `error: ${e?.message || e}`;
  }
  try {
    await backfillReleaseNotificationFlag();
    await runAssignmentReleaseTick();
    results.assignmentReleaseNotifications = "ok";
  } catch (e) {
    results.assignmentReleaseNotifications = `error: ${e?.message || e}`;
  }
  try {
    await runMonthlyInvoiceTick();
    results.monthlyInvoices = "ok";
  } catch (e) {
    results.monthlyInvoices = `error: ${e?.message || e}`;
  }
  try {
    const postSession = await runPostSessionTasksTick();
    results.postSessionTasks = postSession.enabled ? "ok" : `disabled:${postSession.reason || "unknown"}`;
  } catch (e) {
    results.postSessionTasks = `error: ${e?.message || e}`;
  }
  return results;
}

module.exports = { runScheduledTicks };
