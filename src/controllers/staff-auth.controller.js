const { z } = require("zod");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { sendSuccess, sendError } = require("../utils/response");
const { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } = require("../utils/tokens");
const StaffOtpRequest = require("../models/StaffOtpRequest");
const Staff = require("../models/Staff");
const { sendOtpEmail } = require("../services/brevo");
const { permissionsForRole } = require("../utils/rbac");
const { buildLoginMeta } = require("../utils/requestMeta");

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

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyMyPasswordSchema = z.object({
  password: z.string().min(1),
});

const verifyOtpOnlySchema = z.object({
  otp: z.string().length(6),
  otp_request_id: z.string(),
});

const setPasswordWithTokenSchema = z.object({
  token: z.string().min(10),
  new_password: z.string().min(8),
  confirm_password: z.string().min(8),
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

function isStrongPassword(password) {
  if (String(password).length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
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

async function sendForgotPasswordOtp(req, res) {
  const body = sendOtpSchema.parse(req.body);
  const staffDoc = await Staff.findOne({ email: body.email }).lean();
  if (!staffDoc) {
    return sendError(res, 400, "STAFF_NOT_FOUND", "This email is not registered for the admin panel");
  }
  if (!staffDoc.is_active) {
    return sendError(res, 403, "ACCOUNT_DISABLED", "This account is disabled");
  }
  if (!staffDoc.password_set_by_user) {
    return sendError(
      res,
      400,
      "PASSWORD_NOT_SET",
      "You haven’t set your password yet. Please complete signup."
    );
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
    { otp_request_id, expires_in_sec: expiresInSec, resend_after_sec: 30 },
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
  const tv = Number(staffDoc.token_version || 0);
  const access_token = signAccessToken({
    sub,
    role: staffDoc.role,
    email: staffDoc.email,
    staff: true,
    tv,
  });
  const refresh_token = signRefreshToken({ sub, type: "refresh", staff: true, tv });
  await StaffOtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });
  await Staff.updateOne({ _id: sub }, { $set: buildLoginMeta(req) });

  return sendSuccess(res, {
    access_token,
    refresh_token,
    expires_in_sec: 3600,
    staff,
    permissions: permissionsForRole(staffDoc.role),
    redirect_path: redirectForRole(staffDoc.role),
  });
}

async function loginWithPassword(req, res) {
  const body = loginSchema.parse(req.body);
  const email = body.email.trim().toLowerCase();
  const staffDoc = await Staff.findOne({ email });
  if (!staffDoc || !staffDoc.is_active) {
    return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }
  if (!staffDoc.password_set_by_user) {
    return sendError(
      res,
      400,
      "PASSWORD_NOT_SET",
      "You haven’t set your password yet. Please complete signup."
    );
  }
  const ok = bcrypt.compareSync(body.password, staffDoc.password_hash);
  if (!ok) {
    return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }
  const staff = staffPublicFields(staffDoc);
  const sub = String(staffDoc._id);
  const tv = Number(staffDoc.token_version || 0);
  const access_token = signAccessToken({ sub, role: staffDoc.role, email: staffDoc.email, staff: true, tv });
  const refresh_token = signRefreshToken({ sub, type: "refresh", staff: true, tv });
  await Staff.updateOne({ _id: sub }, { $set: buildLoginMeta(req) });
  return sendSuccess(res, {
    access_token,
    refresh_token,
    expires_in_sec: 3600,
    staff,
    permissions: permissionsForRole(staffDoc.role),
    redirect_path: redirectForRole(staffDoc.role),
  });
}

async function verifySignupOtp(req, res) {
  const body = verifyOtpSchema.parse(req.body);
  const record = await StaffOtpRequest.findOne({ otp_request_id: body.otp_request_id, email: body.email }).lean();
  if (!record || record.otp !== body.otp || record.used_at || Date.now() > new Date(record.expires_at).getTime()) {
    return sendError(res, 400, "INVALID_OTP", "Invalid or expired OTP.");
  }
  const staffDoc = await Staff.findOne({ email: body.email }).lean();
  if (!staffDoc || !staffDoc.is_active) {
    return sendError(res, 400, "STAFF_NOT_FOUND", "This email is not registered for the admin panel");
  }
  await StaffOtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });
  const signup_token = signAccessToken({
    sub: String(staffDoc._id),
    email: staffDoc.email,
    role: staffDoc.role,
    staff: true,
    type: "staff_signup_setup",
  });
  return sendSuccess(res, { signup_token, expires_in_sec: 600 }, "OTP verified");
}

async function setPasswordFromSignup(req, res) {
  const body = setPasswordWithTokenSchema.parse(req.body);
  if (body.new_password !== body.confirm_password) {
    return sendError(res, 400, "PASSWORD_MISMATCH", "Passwords must match.");
  }
  if (!isStrongPassword(body.new_password)) {
    return sendError(
      res,
      400,
      "WEAK_PASSWORD",
      "Password must be at least 8 characters and include 1 uppercase letter, 1 number, and 1 special character."
    );
  }
  let decoded;
  try {
    decoded = verifyAccessToken(body.token);
  } catch {
    return sendError(res, 401, "INVALID_SIGNUP_TOKEN", "Signup session expired. Please verify OTP again.");
  }
  if (!decoded?.sub || decoded?.type !== "staff_signup_setup" || !decoded?.staff) {
    return sendError(res, 401, "INVALID_SIGNUP_TOKEN", "Signup session expired. Please verify OTP again.");
  }
  const staff = await Staff.findById(decoded.sub);
  if (!staff || !staff.is_active) return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  staff.password_hash = bcrypt.hashSync(body.new_password, 10);
  staff.password_set_by_user = true;
  // Invalidate any tokens issued before this password change.
  staff.token_version = Number(staff.token_version || 0) + 1;
  await staff.save();
  return sendSuccess(res, {}, "Password created successfully.");
}

async function verifyForgotPasswordOtp(req, res) {
  const body = verifyOtpSchema.parse(req.body);
  const record = await StaffOtpRequest.findOne({ otp_request_id: body.otp_request_id, email: body.email }).lean();
  if (!record || record.otp !== body.otp || record.used_at || Date.now() > new Date(record.expires_at).getTime()) {
    return sendError(res, 400, "INVALID_OTP", "Invalid or expired OTP.");
  }
  const staffDoc = await Staff.findOne({ email: body.email }).lean();
  if (!staffDoc || !staffDoc.is_active) {
    return sendError(res, 400, "STAFF_NOT_FOUND", "This email is not registered for the admin panel");
  }
  await StaffOtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });
  const reset_token = signAccessToken({
    sub: String(staffDoc._id),
    email: staffDoc.email,
    role: staffDoc.role,
    staff: true,
    type: "staff_password_reset",
  });
  return sendSuccess(res, { reset_token, expires_in_sec: 600 }, "OTP verified");
}

async function resetPassword(req, res) {
  const body = setPasswordWithTokenSchema.parse(req.body);
  if (body.new_password !== body.confirm_password) {
    return sendError(res, 400, "PASSWORD_MISMATCH", "Passwords must match.");
  }
  if (!isStrongPassword(body.new_password)) {
    return sendError(
      res,
      400,
      "WEAK_PASSWORD",
      "Password must be at least 8 characters and include 1 uppercase letter, 1 number, and 1 special character."
    );
  }
  let decoded;
  try {
    decoded = verifyAccessToken(body.token);
  } catch {
    return sendError(res, 401, "INVALID_RESET_TOKEN", "Reset session expired. Please verify OTP again.");
  }
  if (!decoded?.sub || decoded?.type !== "staff_password_reset" || !decoded?.staff) {
    return sendError(res, 401, "INVALID_RESET_TOKEN", "Reset session expired. Please verify OTP again.");
  }
  const staff = await Staff.findById(decoded.sub);
  if (!staff || !staff.is_active) return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  staff.password_hash = bcrypt.hashSync(body.new_password, 10);
  staff.password_set_by_user = true;
  // Invalidate any tokens issued before this password change.
  staff.token_version = Number(staff.token_version || 0) + 1;
  await staff.save();
  return sendSuccess(res, {}, "Password reset successfully.");
}

async function sendMePasswordUpdateOtp(req, res) {
  const staffDoc = await Staff.findById(req.staff.sub).lean();
  if (!staffDoc || !staffDoc.is_active) return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  const email = String(staffDoc.email || "").trim().toLowerCase();
  const otp_request_id = `staff_otp_${crypto.randomBytes(6).toString("hex")}`;
  const otp = String(crypto.randomInt(100000, 1000000));
  await StaffOtpRequest.create({
    otp_request_id,
    email,
    otp,
    expires_at: new Date(Date.now() + 120 * 1000),
  });
  try {
    await sendOtpEmail({ toEmail: email, otp, expiresInSec: 120 });
  } catch (error) {
    if (process.env.OTP_DEBUG_LOG !== "false") {
      console.warn("[STAFF_OTP_DEBUG]", error.message);
      console.log(`[STAFF_OTP_DEBUG] OTP for ${email}: ${otp}`);
    }
  }
  return sendSuccess(res, { otp_request_id, expires_in_sec: 120, resend_after_sec: 30 }, "OTP sent");
}

async function verifyMePasswordUpdateOtp(req, res) {
  const body = verifyOtpOnlySchema.parse(req.body);
  const staffDoc = await Staff.findById(req.staff.sub).lean();
  if (!staffDoc || !staffDoc.is_active) return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  const email = String(staffDoc.email || "").trim().toLowerCase();
  const record = await StaffOtpRequest.findOne({ otp_request_id: body.otp_request_id, email }).lean();
  if (!record || record.otp !== body.otp || record.used_at || Date.now() > new Date(record.expires_at).getTime()) {
    return sendError(res, 400, "INVALID_OTP", "Invalid or expired OTP.");
  }
  await StaffOtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });
  const password_update_token = signAccessToken({
    sub: String(staffDoc._id),
    email,
    role: staffDoc.role,
    staff: true,
    type: "staff_me_password_update",
  });
  return sendSuccess(res, { password_update_token, expires_in_sec: 600 }, "OTP verified");
}

async function updateMyPasswordWithOtp(req, res) {
  const schema = z.object({
    password_update_token: z.string().min(10),
    new_password: z.string().min(8),
    confirm_password: z.string().min(8),
  });
  const body = schema.parse(req.body);
  if (body.new_password !== body.confirm_password) {
    return sendError(res, 400, "PASSWORD_MISMATCH", "Passwords must match.");
  }
  if (!isStrongPassword(body.new_password)) {
    return sendError(
      res,
      400,
      "WEAK_PASSWORD",
      "Password must be at least 8 characters and include 1 uppercase letter, 1 number, and 1 special character."
    );
  }
  let decoded;
  try {
    decoded = verifyAccessToken(body.password_update_token);
  } catch {
    return sendError(res, 401, "INVALID_PASSWORD_UPDATE_TOKEN", "Password update session expired. Verify OTP again.");
  }
  if (!decoded?.sub || !decoded?.staff || decoded?.type !== "staff_me_password_update" || String(decoded.sub) !== String(req.staff.sub)) {
    return sendError(res, 401, "INVALID_PASSWORD_UPDATE_TOKEN", "Password update session expired. Verify OTP again.");
  }
  const staff = await Staff.findById(req.staff.sub);
  if (!staff || !staff.is_active) return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  staff.password_hash = bcrypt.hashSync(body.new_password, 10);
  staff.password_set_by_user = true;
  // Invalidate any tokens issued before this password change.
  staff.token_version = Number(staff.token_version || 0) + 1;
  await staff.save();
  return sendSuccess(res, {}, "Password updated successfully.");
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
  // A logout, password change, or being disabled bumps token_version — a refresh token issued
  // before that no longer matches and is rejected here, instead of silently minting a fresh
  // access token for a session that was supposed to have been cut off.
  if (Number(decoded.tv || 0) !== Number(staffDoc.token_version || 0)) {
    return sendError(res, 401, "UNAUTHORIZED", "Session has been signed out. Please log in again.");
  }

  const access_token = signAccessToken({
    sub: String(staffDoc._id),
    role: staffDoc.role,
    email: staffDoc.email,
    staff: true,
    tv: Number(staffDoc.token_version || 0),
  });
  return sendSuccess(res, { access_token, expires_in_sec: 3600 });
}

async function logout(req, res) {
  await Staff.updateOne({ _id: req.staff.sub }, { $inc: { token_version: 1 } });
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

/** Re-enter login password before sensitive admin actions (client-side gate). */
async function verifyMyPassword(req, res) {
  const body = verifyMyPasswordSchema.parse(req.body);
  const staffDoc = await Staff.findById(req.staff.sub);
  if (!staffDoc || !staffDoc.is_active) {
    return sendError(res, 404, "STAFF_NOT_FOUND", "Staff not found");
  }
  if (!staffDoc.password_set_by_user || !String(staffDoc.password_hash || "").trim()) {
    return sendError(
      res,
      400,
      "PASSWORD_NOT_SET",
      "Set your login password in Profile before confirming sensitive actions."
    );
  }
  const ok = bcrypt.compareSync(body.password, staffDoc.password_hash);
  if (!ok) {
    return sendError(res, 401, "INVALID_PASSWORD", "Incorrect password.");
  }
  return sendSuccess(res, { verified: true }, "Password verified");
}

module.exports = {
  sendOtp,
  sendForgotPasswordOtp,
  verifyOtp,
  loginWithPassword,
  verifySignupOtp,
  setPasswordFromSignup,
  verifyForgotPasswordOtp,
  resetPassword,
  sendMePasswordUpdateOtp,
  verifyMePasswordUpdateOtp,
  updateMyPasswordWithOtp,
  refreshToken,
  logout,
  me,
  verifyMyPassword,
};
