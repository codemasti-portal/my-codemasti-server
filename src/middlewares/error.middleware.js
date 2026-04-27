const { sendError } = require("../utils/response");

function notFoundHandler(req, res) {
  return sendError(res, 404, "NOT_FOUND", `Route not found: ${req.originalUrl}`, {}, { method: req.method, url: req.originalUrl });
}

function errorHandler(err, req, res, _next) {
  if (err?.name === "MulterError") {
    return sendError(res, 400, "UPLOAD_ERROR", err.message || "File upload failed", {
      code: err.code,
    });
  }
  if (
    err?.message &&
    (err.message.includes("Only jpeg") || err.message.includes("Only image"))
  ) {
    return sendError(res, 400, "INVALID_FILE", err.message);
  }
  if (err && err.name === "ZodError") {
    const out = sendError(res, 400, "VALIDATION_ERROR", "Request validation failed", err.issues, {
      method: req.method,
      url: req.originalUrl,
    });
    if (err?.stack) console.error(err.stack);
    return out;
  }
  const status = err.statusCode || 500;
  const code = err.code || "INTERNAL_SERVER_ERROR";
  const message = err.message || "Unexpected server error";
  const out = sendError(res, status, code, message, {}, {
    method: req.method,
    url: req.originalUrl,
    name: err?.name,
    underlyingMessage: err?.message,
  });
  if (err?.stack) console.error(err.stack);
  return out;
}

module.exports = { notFoundHandler, errorHandler };
