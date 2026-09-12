/**
 * Rollout cutoff for post-class / post-mentor-session task notifications.
 * Sessions ending before this instant are never eligible (prevents historical spam on deploy).
 *
 * Set POST_SESSION_TASKS_START_AT to an ISO-8601 instant, e.g. 2026-03-15T00:00:00+05:30
 * Missing or malformed → scheduler disabled (fail-safe).
 */

let warnedDisabled = false;

function getPostSessionTasksCutoff() {
  const raw = String(process.env.POST_SESSION_TASKS_START_AT || "").trim();
  if (!raw) {
    if (!warnedDisabled) {
      console.warn(
        "[POST_SESSION_TASKS] Disabled — POST_SESSION_TASKS_START_AT is not set. Post-class/post-session task notifications will not run."
      );
      warnedDisabled = true;
    }
    return { enabled: false, cutoff: null, reason: "missing" };
  }

  const cutoff = new Date(raw);
  if (Number.isNaN(cutoff.getTime())) {
    if (!warnedDisabled) {
      console.warn(
        "[POST_SESSION_TASKS] Disabled — POST_SESSION_TASKS_START_AT is malformed. Post-class/post-session task notifications will not run."
      );
      warnedDisabled = true;
    }
    return { enabled: false, cutoff: null, reason: "malformed" };
  }

  return { enabled: true, cutoff };
}

/** @returns {boolean} Whether sessionEnd is on/after the rollout cutoff. */
function isSessionEndEligibleForPostTasks(sessionEnd, cutoffState) {
  if (!cutoffState?.enabled || !cutoffState.cutoff || !sessionEnd) return false;
  return sessionEnd.getTime() >= cutoffState.cutoff.getTime();
}

module.exports = {
  getPostSessionTasksCutoff,
  isSessionEndEligibleForPostTasks,
};
