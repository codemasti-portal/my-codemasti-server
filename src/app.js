const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { connectDb } = require("./config/db");

const { apiLimiter, otpLimiter } = require("./middlewares/rateLimit.middleware");
const routes = require("./routes");
const { notFoundHandler, errorHandler } = require("./middlewares/error.middleware");

const app = express();
// Behind a reverse proxy (e.g. Nginx on EC2), set TRUST_PROXY=1 so req.ip / rate limits use the real client IP.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}
let dbInitPromise = null;

function parseCorsOrigins(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

const corsOrigins = [
  ...parseCorsOrigins(process.env.CORS_ORIGINS),
  ...parseCorsOrigins(process.env.CORS_ORIGIN),
].filter((origin, index, all) => all.indexOf(origin) === index);

app.use(
  cors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  })
);
app.use(
  helmet({
    // Allow the admin/student frontends (different origins/ports in dev)
    // to embed any resource this API returns.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(
  morgan("dev", {
    skip(req) {
      const path = req.originalUrl || req.url || "";
      return path.includes("/staff/panel-notifications/me/unread-count");
    },
  })
);

// PhonePe webhook must read the raw body for base64 decoding + signature verification.
// It is mounted BEFORE express.json() so the global JSON parser doesn't consume the body first.
{
  const { handlePhonepeWebhook } = require("./controllers/payments-webhook.controller");
  app.post(
    "/v1/payments/webhook/phonepe",
    express.raw({ type: "*/*", limit: "1mb" }),
    handlePhonepeWebhook
  );
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(apiLimiter);

app.use(async (req, res, next) => {
  if (mongoose.connection.readyState === 1) return next();

  try {
    if (!dbInitPromise) {
      dbInitPromise = connectDb().finally(() => {
        dbInitPromise = null;
      });
    }
    await dbInitPromise;
    return next();
  } catch (error) {
    console.error(
      "[ERROR]",
      JSON.stringify({
        context: "DB_CONNECT_ON_REQUEST",
        method: req.method,
        url: req.originalUrl || req.url,
        message: error.message,
        name: error.name,
      })
    );
    if (error.stack) console.error(error.stack);
    return res.status(503).json({
      success: false,
      error: {
        code: "DB_NOT_CONNECTED",
        message: "Database is not connected. Please retry shortly.",
        details: {},
      },
    });
  }
});

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
