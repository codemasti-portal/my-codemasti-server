function sendSuccess(res, data = {}, message = "", meta) {
  const payload = {
    success: true,
    data,
  };
  if (message) payload.message = message;
  if (meta) payload.meta = meta;
  return res.status(200).json(payload);
}

function sendError(res, statusCode, code, message, details = {}, serverOnlyLog) {
  const logPayload = {
    context: "API_ERROR",
    statusCode,
    code,
    message,
  };
  if (details && typeof details === "object" && Object.keys(details).length > 0) {
    logPayload.details = details;
  }
  let stackLine;
  if (serverOnlyLog && typeof serverOnlyLog === "object" && Object.keys(serverOnlyLog).length > 0) {
    const { stack, ...rest } = serverOnlyLog;
    stackLine = stack;
    if (Object.keys(rest).length > 0) {
      Object.assign(logPayload, rest);
    }
  }
  console.error("[ERROR]", JSON.stringify(logPayload));
  if (stackLine) console.error(stackLine);
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details,
    },
  });
}

module.exports = { sendSuccess, sendError };
