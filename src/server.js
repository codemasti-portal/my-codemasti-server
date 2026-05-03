require("dotenv").config();
const app = require("./app");
const { connectDb } = require("./config/db");
const { startMentorReminderScheduler } = require("./services/mentor-reminder.scheduler");
const { startTimetableClassReminderScheduler } = require("./services/timetable-class-reminder.scheduler");
const { startNotificationCleanupScheduler } = require("./services/notification-cleanup.scheduler");

const PORT = process.env.PORT || 5000;

async function bootstrap() {
  try {
    await connectDb();
    startMentorReminderScheduler();
    startTimetableClassReminderScheduler();
    startNotificationCleanupScheduler();
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
