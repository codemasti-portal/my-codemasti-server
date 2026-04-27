const { z } = require("zod");
const crypto = require("crypto");
const { sendSuccess, sendError } = require("../utils/response");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../utils/tokens");
const OtpRequest = require("../models/OtpRequest");
const Student = require("../models/Student");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { sendOtpEmail } = require("../services/brevo");

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

async function sendOtp(req, res) {
  const body = sendOtpSchema.parse(req.body);
  const otp_request_id = `otp_req_${crypto.randomBytes(6).toString("hex")}`;
  const otp = String(crypto.randomInt(100000, 1000000));

  const studentDoc = await Student.findOne({ email: body.email }).lean();
  if (!studentDoc) {
    return sendError(res, 400, "STUDENT_NOT_REGISTERED", "This email is not registered");
  }

  await OtpRequest.create({
    otp_request_id,
    email: body.email,
    otp,
    expires_at: new Date(Date.now() + 120 * 1000),
  });

  const expiresInSec = 120;
  try {
    await sendOtpEmail({ toEmail: body.email, otp, expiresInSec });
  } catch (error) {
    // Helpful for dev/testing if Brevo is not configured.
    // Security note: OTP is NOT returned to the client.
    if (process.env.OTP_DEBUG_LOG !== "false") {
      console.warn("[OTP_DEBUG]", error.message);
      console.log(`[OTP_DEBUG] OTP for ${body.email}: ${otp}`);
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
  const record = await OtpRequest.findOne({ otp_request_id: body.otp_request_id, email: body.email }).lean();

  if (!record || record.otp !== body.otp) {
    return sendError(res, 400, "INVALID_OTP", "Invalid OTP or request id");
  }
  if (record.used_at) {
    return sendError(res, 400, "OTP_ALREADY_USED", "OTP already used");
  }
  if (Date.now() > new Date(record.expires_at).getTime()) {
    return sendError(res, 400, "OTP_EXPIRED", "OTP has expired");
  }

  const studentDoc = await Student.findOne({ email: body.email }).lean();
  if (!studentDoc) {
    return sendError(res, 400, "STUDENT_NOT_REGISTERED", "This email is not registered");
  }

  const d = augmentStudentCatalogFieldsFromEnrollment(studentDoc);
  const student = {
    id: String(d._id),
    name: d.name,
    email: d.email,
    batch: d.batch,
    batch_id: d.batch_id,
    role: d.role,
    parent_name: d.parent_name,
    phone_number: d.phone_number,
    student_phone: d.student_phone || "",
    whatsapp_number: d.whatsapp_number || "",
    school_name: d.school_name || "",
    cst_registration_id: d.cst_registration_id || "",
    enrollment_number: d.enrollment_number,
    enrollment_batch_prefix: d.enrollment_batch_prefix,
    enrollment_batch_name: d.enrollment_batch_name,
    enrollment_year: d.enrollment_year,
    enrollment_section: d.enrollment_section,
    section_id: d.section_id,
    enrollment_roll_no: d.enrollment_roll_no,
    batch_allowance: d.batch_allowance,
    course: d.course,
    avatar_url: d.avatar_url,
    progress: d.progress,
    enrollment_date: d.enrollment_date,
    school_class: d.school_class ?? null,
  };

  const access_token = signAccessToken({ sub: student.id, role: student.role, email: student.email });
  const refresh_token = signRefreshToken({ sub: student.id, type: "refresh" });
  await OtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });

  return sendSuccess(res, {
    access_token,
    refresh_token,
    expires_in_sec: 3600,
    student,
  });
}

async function googleLogin(req, res) {
  const schema = z.object({ id_token: z.string().min(10) });
  const body = schema.parse(req.body);

  let tokenPayload;
  try {
    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.id_token)}`;
    const tokenRes = await fetch(verifyUrl);
    tokenPayload = await tokenRes.json();
    if (!tokenRes.ok) {
      return sendError(
        res,
        401,
        "INVALID_ID_TOKEN",
        tokenPayload.error_description || tokenPayload.error || "Invalid Google token"
      );
    }
  } catch (e) {
    return sendError(res, 502, "GOOGLE_VERIFY_FAILED", "Could not verify Google token");
  }

  const googleAud = process.env.GOOGLE_CLIENT_ID;
  if (googleAud && tokenPayload.aud !== googleAud) {
    return sendError(res, 401, "INVALID_AUDIENCE", "Google token audience does not match GOOGLE_CLIENT_ID");
  }

  const email = String(tokenPayload.email || "").toLowerCase().trim();
  if (!email) {
    return sendError(res, 400, "INVALID_ID_TOKEN", "Google token did not include an email");
  }

  const studentDoc = await Student.findOne({ email }).lean();
  if (!studentDoc) {
    return sendError(res, 400, "STUDENT_NOT_REGISTERED", "This email is not registered");
  }

  const d = augmentStudentCatalogFieldsFromEnrollment(studentDoc);
  const student = {
    id: String(d._id),
    name: d.name,
    email: d.email,
    batch: d.batch,
    batch_id: d.batch_id,
    role: d.role,
    parent_name: d.parent_name,
    phone_number: d.phone_number,
    student_phone: d.student_phone || "",
    whatsapp_number: d.whatsapp_number || "",
    school_name: d.school_name || "",
    cst_registration_id: d.cst_registration_id || "",
    enrollment_number: d.enrollment_number,
    enrollment_batch_prefix: d.enrollment_batch_prefix,
    enrollment_batch_name: d.enrollment_batch_name,
    enrollment_year: d.enrollment_year,
    enrollment_section: d.enrollment_section,
    section_id: d.section_id,
    enrollment_roll_no: d.enrollment_roll_no,
    course: d.course,
    avatar_url: d.avatar_url,
    progress: d.progress,
    enrollment_date: d.enrollment_date,
    school_class: d.school_class ?? null,
  };

  const access_token = signAccessToken({ sub: student.id, role: student.role, email: student.email });
  const refresh_token = signRefreshToken({ sub: student.id, type: "refresh" });

  return sendSuccess(res, {
    access_token,
    refresh_token,
    expires_in_sec: 3600,
    student,
  });
}

async function refreshToken(req, res) {
  const body = refreshSchema.parse(req.body);
  if (!body.refresh_token) return sendError(res, 400, "INVALID_REFRESH_TOKEN", "Refresh token is required");

  let decoded;
  try {
    decoded = verifyRefreshToken(body.refresh_token);
  } catch (error) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid refresh token", {}, {
      context: "AUTH_REFRESH_TOKEN_VERIFY",
      name: error?.name,
      cause: error?.message,
      stack: error?.stack,
    });
  }
  if (!decoded?.sub) {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid refresh token");
  }
  const studentDoc = await Student.findById(decoded.sub).lean();
  if (!studentDoc) {
    return sendError(res, 401, "UNAUTHORIZED", "Student not found for token");
  }

  const access_token = signAccessToken({
    sub: String(studentDoc._id),
    role: studentDoc.role,
    email: studentDoc.email,
  });
  return sendSuccess(res, { access_token, expires_in_sec: 3600 });
}

function logout(_req, res) {
  return sendSuccess(res, {}, "Logged out");
}

async function me(req, res) {
  const studentDoc = await Student.findById(req.user.sub).lean();
  if (!studentDoc) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  const d = augmentStudentCatalogFieldsFromEnrollment(studentDoc);
  return sendSuccess(res, {
    student: {
      id: String(d._id),
      name: d.name,
      email: d.email,
      batch: d.batch,
      batch_id: d.batch_id,
      role: d.role,
      parent_name: d.parent_name,
      phone_number: d.phone_number,
      student_phone: d.student_phone || "",
      whatsapp_number: d.whatsapp_number || "",
      school_name: d.school_name || "",
      cst_registration_id: d.cst_registration_id || "",
      enrollment_number: d.enrollment_number,
      enrollment_batch_prefix: d.enrollment_batch_prefix,
      enrollment_batch_name: d.enrollment_batch_name,
      enrollment_year: d.enrollment_year,
      enrollment_section: d.enrollment_section,
      section_id: d.section_id,
      enrollment_roll_no: d.enrollment_roll_no,
      batch_allowance: d.batch_allowance,
      course: d.course,
      avatar_url: d.avatar_url,
      progress: d.progress,
      enrollment_date: d.enrollment_date,
      school_class: d.school_class ?? null,
    },
    permissions: ["read:notes", "write:submissions"],
  });
}

module.exports = { sendOtp, verifyOtp, googleLogin, refreshToken, logout, me };
