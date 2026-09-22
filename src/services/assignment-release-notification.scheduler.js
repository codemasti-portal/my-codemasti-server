const Assignment = require("../models/Assignment");
const { notifyAssignmentReleasedIfEligible } = require("./assignment-notifications.service");
const { filterAssignmentsOpenToStudents } = require("../utils/projectPublication");
const { isProjectAssignmentType } = require("../utils/projectQuestionPolicy");

const CHECK_INTERVAL_MS = 60 * 1000;

/** Mark already-published assignments so we do not blast “new assignment” retroactively after deploy. */
async function backfillReleaseNotificationFlag() {
  try {
    const now = new Date();
    const nonProject = await Assignment.updateMany(
      {
        assignment_type: { $ne: "project" },
        release_date: { $lte: now },
        $or: [{ release_notification_sent_at: { $exists: false } }, { release_notification_sent_at: null }],
      },
      [{ $set: { release_notification_sent_at: "$release_date" } }],
      { updatePipeline: true }
    );

    const projectCandidates = await Assignment.find({
      assignment_type: "project",
      project_published: { $ne: false },
      release_date: { $lte: now },
      $or: [{ release_notification_sent_at: { $exists: false } }, { release_notification_sent_at: null }],
    }).lean();
    const openProjects = await filterAssignmentsOpenToStudents(projectCandidates);
    const openIds = openProjects.map((a) => a._id);
    let projectModified = 0;
    if (openIds.length) {
      const project = await Assignment.updateMany(
        { _id: { $in: openIds }, release_notification_sent_at: null },
        [{ $set: { release_notification_sent_at: "$release_date" } }],
        { updatePipeline: true }
      );
      projectModified = project.modifiedCount || 0;
    }

    const modifiedCount = (nonProject.modifiedCount || 0) + projectModified;
    if (modifiedCount > 0) {
      console.log("[ASSIGNMENT_NOTIFY_BACKFILL]", { modifiedCount });
    }
  } catch (e) {
    console.error("[ASSIGNMENT_NOTIFY_BACKFILL_FAILED]", e?.message || e);
  }
}

async function runTick() {
  const now = new Date();
  const candidates = await Assignment.find({
    release_date: { $lte: now },
    release_notification_sent_at: null,
    $nor: [{ assignment_type: "project", project_published: false }],
  })
    .sort({ release_date: 1 })
    .limit(80)
    .lean();

  const nonProjects = candidates.filter((row) => !isProjectAssignmentType(row.assignment_type));
  const openProjects = await filterAssignmentsOpenToStudents(
    candidates.filter((row) => isProjectAssignmentType(row.assignment_type))
  );
  const ready = [...nonProjects, ...openProjects]
    .sort((a, b) => new Date(a.release_date).getTime() - new Date(b.release_date).getTime())
    .slice(0, 40);

  for (const row of ready) {
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
