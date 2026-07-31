require("dotenv").config();
const app = require("./app");
const { connectDb } = require("./config/db");
const { startMentorReminderScheduler } = require("./services/mentor-reminder.scheduler");
const { startTimetableClassReminderScheduler } = require("./services/timetable-class-reminder.scheduler");
const { startEventReminderScheduler } = require("./services/timetable-event-reminder.scheduler");
const { startAssignmentReleaseNotificationScheduler } = require("./services/assignment-release-notification.scheduler");
const { startNotificationCleanupScheduler } = require("./services/notification-cleanup.scheduler");
const { startMonthlyInvoiceScheduler } = require("./services/monthly-invoice.scheduler");
const { runMentorPublishSweepTick } = require("./services/mentor-notification.service");

const PORT = process.env.PORT || 5001;

async function bootstrap() {
  try {
    await connectDb();
    startMentorReminderScheduler();
    startTimetableClassReminderScheduler();
    startEventReminderScheduler();
    // Mentor publish-sweep: future publish_date slots that were never fanout'd.
    setInterval(() => {
      runMentorPublishSweepTick().catch((e) => {
        console.error("[MENTOR_PUBLISH_SWEEP_TICK_FAILED]", e?.message || e);
      });
    }, 60 * 1000);
    runMentorPublishSweepTick().catch(() => {});
    startAssignmentReleaseNotificationScheduler();
    startNotificationCleanupScheduler();
    startMonthlyInvoiceScheduler();
    app.listen(PORT, () => {
      console.log(`CodeMasti API running on port ${PORT}`);
    });
  } catch (error) {
    console.error(
      "[ERROR]",
      JSON.stringify({
        context: "SERVER_BOOTSTRAP",
        message: error.message,
        name: error.name,
      })
    );
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[ERROR]", JSON.stringify({ context: "UNHANDLED_REJECTION", reason: String(reason) }));
  if (reason && reason.stack) console.error(reason.stack);
});

process.on("uncaughtException", (err) => {
  console.error(
    "[ERROR]",
    JSON.stringify({ context: "UNCAUGHT_EXCEPTION", message: err.message, name: err.name })
  );
  console.error(err.stack);
  process.exit(1);
});

bootstrap();
