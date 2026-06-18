const express = require("express");
const { sendSuccess, sendError } = require("../../utils/response");
const { runScheduledTicks } = require("../../services/cron-runner");

const router = express.Router();

/**
 * Guards the cron endpoint with a shared secret so only the external cron pinger can call it.
 * Set CRON_SECRET and pass it as the `x-cron-secret` header or `?key=` query param.
 */
function authorizeCron(req, res, next) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return sendError(res, 503, "CRON_NOT_CONFIGURED", "CRON_SECRET is not set");
  const provided = String(req.get("x-cron-secret") || req.query.key || "").trim();
  if (!provided || provided !== secret) return sendError(res, 401, "UNAUTHORIZED", "Invalid cron secret");
  return next();
}

async function run(req, res) {
  const results = await runScheduledTicks();
  return sendSuccess(res, { ran_at: new Date().toISOString(), results }, "Cron tick complete");
}

// GET and POST both work so any cron service (most send GET) can trigger it.
router.get("/cron/run", authorizeCron, run);
router.post("/cron/run", authorizeCron, run);

module.exports = router;
