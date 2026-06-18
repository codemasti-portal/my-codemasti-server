const { runReminderTick } = require("./timetable-class-reminder.scheduler");

/**
 * Runs the time-sensitive scheduler ticks once. Called by the external cron pinger
 * (every minute) via POST /v1/internal/cron/run, since in-process setInterval timers
 * don't run on Vercel's serverless functions.
 *
 * Each tick is idempotent (atomic claim + *_sent_at markers), so running it late or
 * twice never produces duplicate emails.
 */
async function runScheduledTicks() {
  const results = {};
  try {
    await runReminderTick();
    results.classReminders = "ok";
  } catch (e) {
    results.classReminders = `error: ${e?.message || e}`;
  }
  return results;
}

module.exports = { runScheduledTicks };
