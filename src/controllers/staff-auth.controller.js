const { z } = require("zod");
const crypto = require("crypto");
const { sendSuccess, sendError } = require("../utils/response");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../utils/tokens");
const StaffOtpRequest = require("../models/StaffOtpRequest");
const Staff = require("../models/Staff");
const { sendOtpEmail } = require("../services/brevo");
const { permissionsForRole } = require("../utils/rbac");

const sendOtpSchema = z.object({
  email: z.string().email(),
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
  otp_request_id: z.string(),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(10),
});

function staffPublicFields(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    role: doc.role,
    is_active: doc.is_active,
    profile_image_url: doc.profile_image_url || "",
  };
}

async function sendOtp(req, res) {
  const body = sendOtpSchema.parse(req.body);
  const staffDoc = await Staff.findOne({ email: body.email }).lean();
  if (!staffDoc) {
    return sendError(res, 400, "STAFF_NOT_FOUND", "This email is not registered for the admin panel");
  }
  if (!staffDoc.is_active) {
    return sendError(res, 403, "ACCOUNT_DISABLED", "This account is disabled");
  }

  const otp_request_id = `staff_otp_${crypto.randomBytes(6).toString("hex")}`;
  const otp = String(crypto.randomInt(100000, 1000000));

  await StaffOtpRequest.create({
    otp_request_id,
    email: body.email,
    otp,
    expires_at: new Date(Date.now() + 120 * 1000),
  });

  const expiresInSec = 120;
  try {
    await sendOtpEmail({ toEmail: body.email, otp, expiresInSec });
  } catch (error) {
    if (process.env.OTP_DEBUG_LOG !== "false") {
      console.warn("[STAFF_OTP_DEBUG]", error.message);
      console.log(`[STAFF_OTP_DEBUG] OTP for ${body.email}: ${otp}`);
    }
  }

  return sendSuccess(
    res,
    {
      otp_request_id,
      expires_in_sec: expiresInSec,
      resend_after_sec: 30,
    },
    "OTP sent"
  );
}

async function verifyOtp(req, res) {
  const body = verifyOtpSchema.parse(req.body);
  const record = await StaffOtpRequest.findOne({ otp_request_id: body.otp_request_id, email: body.email }).lean();

  if (!record || record.otp !== body.otp) {
    return sendError(res, 400, "INVALID_OTP", "Invalid OTP or request id");
  }
  if (record.used_at) {
    return sendError(res, 400, "OTP_ALREADY_USED", "OTP already used");
  }
  if (Date.now() > new Date(record.expires_at).getTime()) {
    return sendError(res, 400, "OTP_EXPIRED", "OTP has expired");
  }

  const staffDoc = await Staff.findOne({ email: body.email }).lean();
  if (!staffDoc || !staffDoc.is_active) {
    return sendError(res, 400, "STAFF_NOT_FOUND", "Staff account not available");
  }

  const staff = staffPublicFields(staffDoc);
  const sub = String(staffDoc._id);
  const access_token = signAccessToken({
    sub,
    role: staffDoc.role,
    email: staffDoc.email,
    staff: true,
  });
  const refresh_token = signRefreshToken({ sub, type: "refresh", staff: true });
  await StaffOtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });

  return sendSuccess(res, {
    access_token,
    refresh_token,
    expires_in_sec: 3600,
    staff,
    permissions: permissionsForRole(staffDoc.role),
    redirect_path: redirectForRole(staffDoc.role),
  });
}

function redirectForRole(role) {
  const map = {
    super_admin: "/dashboard/super-admin",
    admin: "/dashboard/admin",
    instructor: "/dashboard/instructor",
    mentor: "/dashboard/mentor",
  };
  return map[role] || "/login";
}

async function refreshToken(req, res) {
  const body = refreshSchema.parse(req.body);
  if (!body.refresh_token) return sendError(res, 400, "INVALID_REFRESH_TOKEN", "Refresh token is required");

  let decoded;
  try {
    decoded = verifyRefreshToken(body.refresh_token);
  } catch (error) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid refresh token", {}, {
      context: "STAFF_AUTH_REFRESH_TOKEN_VERIFY",
      cause: error?.message,
    });
  }
  if (!decoded?.sub || !decoded.staff) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid refresh token");
  }
  const staffDoc = await Staff.findById(decoded.sub).lean();
  if (!staffDoc || !staffDoc.is_active) {
    return sendError(res, 401, "UNAUTHORIZED", "Staff not found for token");
  }

  const access_token = signAccessToken({
    sub: String(staffDoc._id),
    role: staffDoc.role,
    email: staffDoc.email,
    staff: true,
  });
  return sendSuccess(res, { access_token, expires_in_sec: 3600 });
}

function logout(_req, res) {
  return sendSuccess(res, {}, "Logged out");
}

async function me(req, res) {
  const staffDoc = await Staff.findById(req.staff.sub).lean();
  if (!staffDoc) {
    return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  }
  return sendSuccess(res, {
    staff: staffPublicFields(staffDoc),
    permissions: permissionsForRole(staffDoc.role),
    redirect_path: redirectForRole(staffDoc.role),
  });
}

module.exports = { sendOtp, verifyOtp, refreshToken, logout, me };
