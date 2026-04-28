const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { getUploadsRoot } = require("./utils/upload-paths");

const { apiLimiter, otpLimiter } = require("./middlewares/rateLimit.middleware");
const routes = require("./routes");
const { notFoundHandler, errorHandler } = require("./middlewares/error.middleware");

const app = express();

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

app.use(
  cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  })
);
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(apiLimiter);

const uploadsRoot = getUploadsRoot();
fs.mkdirSync(path.join(uploadsRoot, "avatars"), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, "doubt-images"), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, "staff-profile-images"), { recursive: true });
fs.mkdirSync(path.join(uploadsRoot, "staff-resumes"), { recursive: true });
app.use("/v1/static", express.static(uploadsRoot));

app.get("/health", (_req, res) => {
  return res.status(200).json({
    success: true,
    data: { status: "ok" },
    message: "Service healthy",
  });
});

app.get("/health/db", async (_req, res) => {
  try {
    if (!mongoose.connection?.db) {
      console.error(
        "[ERROR]",
        JSON.stringify({ context: "HEALTH_DB_NOT_READY", path: "/health/db" })
      );
      return res.status(503).json({
        success: false,
        error: {
          code: "DB_NOT_CONNECTED",
          message: "MongoDB connection is not ready",
          details: {},
        },
      });
    }

    await mongoose.connection.db.command({ ping: 1 });
    return res.status(200).json({
      success: true,
      data: { status: "ok", db: "up" },
      message: "Database healthy",
    });
  } catch (error) {
    console.error(
      "[ERROR]",
      JSON.stringify({
        context: "HEALTH_DB_PING_FAILED",
        path: "/health/db",
        message: error.message,
        name: error.name,
      })
    );
    if (error.stack) console.error(error.stack);
    return res.status(503).json({
      success: false,
      error: {
        code: "DB_PING_FAILED",
        message: "Database ping failed",
        details: { reason: error.message },
      },
    });
  }
});

app.use("/v1/auth/otp", otpLimiter);
app.use("/v1/staff-auth/otp", otpLimiter);
app.use("/v1", routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
