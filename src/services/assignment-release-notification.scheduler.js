const Assignment = require("../models/Assignment");
const { notifyAssignmentReleasedIfEligible } = require("./assignment-notifications.service");

const CHECK_INTERVAL_MS = 60 * 1000;

/** Mark already-published assignments so we do not blast “new assignment” retroactively after deploy. */
async function backfillReleaseNotificationFlag() {
  try {
    const now = new Date();
    const r = await Assignment.updateMany(
      {
        release_date: { $lte: now },
        $or: [{ release_notification_sent_at: { $exists: false } }, { release_notification_sent_at: null }],
      },
      [{ $set: { release_notification_sent_at: "$release_date" } }]
    );
    if (r.modifiedCount > 0) {
      console.log("[ASSIGNMENT_NOTIFY_BACKFILL]", { modifiedCount: r.modifiedCount });
    }
  } catch (e) {
    console.error("[ASSIGNMENT_NOTIFY_BACKFILL_FAILED]", e?.message || e);
  }
}

async function runTick() {
  const candidates = await Assignment.find({
    release_date: { $lte: now },
    release_notification_sent_at: null,
  })
    .sort({ release_date: 1 })
    .limit(40)
    .lean();

  for (const row of candidates) {
    try {
      await notifyAssignmentReleasedIfEligible(row);
    } catch (e) {
      console.warn("[ASSIGNMENT_RELEASE_NOTIFY_FAILED]", String(row._id), e?.message || e);
    }
  }
}

function startAssignmentReleaseNotificationScheduler() {
  const enabled = String(process.env.ASSIGNMENT_RELEASE_NOTIFY_SCHEDULER || "1").trim() !== "0";
  if (!enabled) {
    console.log("[ASSIGNMENT_RELEASE_NOTIFY_SCHEDULER] disabled via ASSIGNMENT_RELEASE_NOTIFY_SCHEDULER=0");
    return;
  }

  let backfillPromise = backfillReleaseNotificationFlag();

  const loop = async () => {
    try {
      await backfillPromise;
    } catch {
      /* backfill logs its own errors */
    }
    try {
      await runTick();
    } catch (e) {
      console.error("[ASSIGNMENT_RELEASE_NOTIFY_TICK]", e?.message || e);
    }
  };

  void loop();
  setInterval(loop, CHECK_INTERVAL_MS);
}

module.exports = { startAssignmentReleaseNotificationScheduler, runTick, backfillReleaseNotificationFlag };
