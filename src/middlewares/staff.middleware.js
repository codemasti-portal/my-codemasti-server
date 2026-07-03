const { verifyAccessToken } = require("../utils/tokens");
const { sendError } = require("../utils/response");
const Staff = require("../models/Staff");

async function requireStaffAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing bearer token", {}, { method: req.method, url: req.originalUrl });
  }
  const token = header.split(" ")[1];
  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (error) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token", {}, {
      method: req.method,
      url: req.originalUrl,
      cause: error?.message,
    });
  }
  if (!decoded?.staff) {
    return sendError(res, 401, "UNAUTHORIZED", "Staff token required", {}, { method: req.method, url: req.originalUrl });
  }

  try {
    // Revocation check: logout, a password change, or an admin disabling this account bumps
    // token_version, which invalidates every token issued before that moment immediately —
    // instead of the old behavior of waiting out the access token's natural 1h expiry (or the
    // refresh token's 30d expiry for logout specifically). Tokens issued before this check
    // existed carry no `tv` claim, which compares equal to a fresh account's default `token_version`
    // of 0, so existing sessions keep working without forcing anyone to re-login.
    const staffDoc = await Staff.findById(decoded.sub).select("token_version is_active").lean();
    if (!staffDoc || !staffDoc.is_active || Number(decoded.tv || 0) !== Number(staffDoc.token_version || 0)) {
      return sendError(res, 401, "UNAUTHORIZED", "Session expired, please log in again", {}, {
        method: req.method,
        url: req.originalUrl,
      });
    }
  } catch (error) {
    return sendError(res, 401, "UNAUTHORIZED", "Could not verify session", {}, {
      method: req.method,
      url: req.originalUrl,
      cause: error?.message,
    });
  }

  req.staff = decoded;
  req.user = decoded;
  return next();
}

function requireStaffRoles(allowedRoles) {
  return (req, res, next) => {
    const role = req.staff?.role;
    if (!role || !allowedRoles.includes(role)) {
      return sendError(res, 403, "FORBIDDEN", "Insufficient permissions");
    }
    return next();
  };
}

module.exports = { requireStaffAuth, requireStaffRoles };
