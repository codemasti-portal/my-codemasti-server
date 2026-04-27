const { verifyAccessToken } = require("../utils/tokens");
const { sendError } = require("../utils/response");

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing bearer token", {}, { method: req.method, url: req.originalUrl });
  }
  const token = header.split(" ")[1];
  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded;
    return next();
  } catch (error) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token", {}, { method: req.method, url: req.originalUrl, cause: error?.message });
  }
}

module.exports = { requireAuth };
