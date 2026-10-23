const { z } = require("zod");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const OtpRequest = require("../models/OtpRequest");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const { sendOtpEmail } = require("../services/brevo");
const { signAccessToken, verifyAccessToken } = require("../utils/tokens");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildStudentAvatarFolder,
  UPLOAD_UNAVAILABLE_MESSAGE,
  UPLOAD_FAILED_MESSAGE,
} = require("../utils/cloudinary");
const { scopeStudentToBatch } = require("../utils/student-batch-context");
const { catalogSubjects } = require("../utils/catalog-subjects");

async function getMe(req, res) {
  const student = await Student.findById(req.user.sub).lean();
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }

  const s = augmentStudentCatalogFieldsFromEnrollment(student);
  return sendSuccess(res, {
    name: s.name,
    email: s.email,
    course: s.course,
    batch: s.batch,
    batch_id: s.batch_id,
    parent_name: s.parent_name,
    phone_number: s.phone_number,
    student_phone: s.student_phone || "",
    whatsapp_number: s.whatsapp_number || "",
    school_name: s.school_name || "",
    cst_registration_id: s.cst_registration_id || "",
    enrollment_number: s.enrollment_number,
    enrollment_batch_prefix: s.enrollment_batch_prefix,
    enrollment_batch_name: s.enrollment_batch_name,
    enrollment_year: s.enrollment_year,
    enrollment_section: s.enrollment_section,
    section_id: s.section_id,
    enrollment_roll_no: s.enrollment_roll_no,
    batch_allowance: s.batch_allowance,
    enrollment_date: s.enrollment_date,
    avatar_url: s.avatar_url,
    progress: s.progress,
    school_class: s.school_class ?? null,
  });
}

async function patchMe(req, res) {
  const schema = z.object({
    name: z.string().min(2).optional(),
    section_id: z.string().trim().optional(),
    school_class: z.number().int().min(1).max(12).nullable().optional(),
    student_phone: z.string().trim().max(20).optional(),
    whatsapp_number: z.string().trim().max(20).optional(),
    school_name: z.string().trim().max(120).optional(),
    cst_registration_id: z.string().trim().max(60).optional(),
  });
  const body = schema.parse(req.body);
  const $set = {};
  if (body.name !== undefined) $set.name = body.name;
  if (body.section_id !== undefined) $set.section_id = body.section_id;
  if (body.school_class !== undefined) $set.school_class = body.school_class;
  if (body.student_phone !== undefined) $set.student_phone = body.student_phone;
  if (body.whatsapp_number !== undefined) $set.whatsapp_number = body.whatsapp_number;
  if (body.school_name !== undefined) $set.school_name = body.school_name;
  if (body.cst_registration_id !== undefined) $set.cst_registration_id = body.cst_registration_id;
  const updated = await Student.findByIdAndUpdate(req.user.sub, { $set }, { new: true }).lean();
  if (!updated) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  const s = augmentStudentCatalogFieldsFromEnrollment(updated);
  return sendSuccess(
    res,
    {
      name: s.name,
      email: s.email,
      course: s.course,
      batch: s.batch,
      batch_id: s.batch_id,
      parent_name: s.parent_name,
      phone_number: s.phone_number,
      student_phone: s.student_phone || "",
      whatsapp_number: s.whatsapp_number || "",
      school_name: s.school_name || "",
      cst_registration_id: s.cst_registration_id || "",
      enrollment_number: s.enrollment_number,
      enrollment_batch_prefix: s.enrollment_batch_prefix,
      enrollment_batch_name: s.enrollment_batch_name,
      enrollment_year: s.enrollment_year,
      enrollment_section: s.enrollment_section,
      section_id: s.section_id,
      enrollment_roll_no: s.enrollment_roll_no,
      batch_allowance: s.batch_allowance,
      enrollment_date: s.enrollment_date,
      avatar_url: s.avatar_url,
      progress: s.progress,
      school_class: s.school_class ?? null,
    },
    "Profile updated"
  );
}

async function uploadAvatar(req, res) {
  if (!req.file?.buffer) {
    return sendError(res, 400, "NO_FILE", 'Expected multipart field "file"');
  }
  const studentId = req.user.sub;
  if (!isCloudinaryConfigured()) {
    return sendError(res, 503, "CLOUDINARY_NOT_CONFIGURED", UPLOAD_UNAVAILABLE_MESSAGE, {}, { upload: "student_own_avatar" });
  }
  let avatar_url;
  try {
    const folder = buildStudentAvatarFolder(studentId);
    const result = await uploadBufferToFolder(req.file.buffer, "image", folder);
    avatar_url = result.secure_url || result.url;
  } catch (e) {
    return sendError(res, 500, "AVATAR_UPLOAD_FAILED", UPLOAD_FAILED_MESSAGE, {}, {
      upload: "student_own_avatar",
      cause: e?.message,
      stack: e?.stack,
    });
  }

  const updated = await Student.findByIdAndUpdate(studentId, { $set: { avatar_url } }, { new: true }).lean();
  if (!updated) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  return sendSuccess(res, { avatar_url }, "Avatar updated");
}

async function changePassword(req, res) {
  const schema = z.object({
    current_password: z.string().optional(),
    new_password: z.string().min(8),
    confirm_password: z.string().min(8),
  });
  const body = schema.parse(req.body);
  if (body.new_password !== body.confirm_password) {
    return sendError(res, 400, "PASSWORD_MISMATCH", "New passwords do not match");
  }

  const student = await Student.findById(req.user.sub);
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");

  if (student.password_hash) {
    if (!body.current_password || !bcrypt.compareSync(body.current_password, student.password_hash)) {
      return sendError(res, 400, "INVALID_PASSWORD", "Current password is incorrect");
    }
  }

  student.password_hash = bcrypt.hashSync(body.new_password, 10);
  student.password_set_by_user = true;
  await student.save();
  return sendSuccess(res, {}, "Password updated");
}

async function sendPasswordUpdateOtp(req, res) {
  const student = await Student.findById(req.user.sub).lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  const email = String(student.email || "").trim().toLowerCase();
  if (!email) return sendError(res, 400, "EMAIL_NOT_FOUND", "No email found for this account");

  const otp_request_id = `otp_req_${crypto.randomBytes(6).toString("hex")}`;
  const otp = String(crypto.randomInt(100000, 1000000));
  await OtpRequest.create({
    otp_request_id,
    email,
    otp,
    expires_at: new Date(Date.now() + 120 * 1000),
  });

  const expiresInSec = 120;
  try {
    await sendOtpEmail({ toEmail: email, otp, expiresInSec });
  } catch (error) {
    if (process.env.OTP_DEBUG_LOG !== "false") {
      console.warn("[OTP_DEBUG]", error.message);
      console.log(`[OTP_DEBUG] OTP for ${email}: ${otp}`);
    }
  }

  return sendSuccess(
    res,
    { otp_request_id, expires_in_sec: expiresInSec, resend_after_sec: 30 },
    "OTP sent"
  );
}

async function verifyPasswordUpdateOtp(req, res) {
  const schema = z.object({
    otp: z.string().length(6),
    otp_request_id: z.string(),
  });
  const body = schema.parse(req.body);
  const student = await Student.findById(req.user.sub).lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  const email = String(student.email || "").trim().toLowerCase();

  const record = await OtpRequest.findOne({ otp_request_id: body.otp_request_id, email }).lean();
  if (!record || record.otp !== body.otp) {
    return sendError(res, 400, "INVALID_OTP", "Invalid or expired OTP.");
  }
  if (record.used_at || Date.now() > new Date(record.expires_at).getTime()) {
    return sendError(res, 400, "OTP_EXPIRED", "Invalid or expired OTP.");
  }
  await OtpRequest.updateOne({ _id: record._id }, { $set: { used_at: new Date() } });

  const password_update_token = signAccessToken({
    sub: String(student._id),
    email,
    type: "student_password_update",
  });
  return sendSuccess(res, { password_update_token, expires_in_sec: 600 }, "OTP verified");
}

async function updatePasswordWithOtp(req, res) {
  const schema = z.object({
    password_update_token: z.string().min(10),
    new_password: z.string().min(8),
    confirm_password: z.string().min(8),
  });
  const body = schema.parse(req.body);
  if (body.new_password !== body.confirm_password) {
    return sendError(res, 400, "PASSWORD_MISMATCH", "Passwords must match.");
  }
  if (!/[A-Z]/.test(body.new_password) || !/[0-9]/.test(body.new_password) || !/[^A-Za-z0-9]/.test(body.new_password)) {
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
  if (!decoded?.sub || decoded?.type !== "student_password_update" || String(decoded.sub) !== String(req.user.sub)) {
    return sendError(res, 401, "INVALID_PASSWORD_UPDATE_TOKEN", "Password update session expired. Verify OTP again.");
  }

  const student = await Student.findById(req.user.sub);
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  student.password_hash = bcrypt.hashSync(body.new_password, 10);
  student.password_set_by_user = true;
  await student.save();
  return sendSuccess(res, {}, "Password updated successfully.");
}

/**
 * GET /v1/students/subjects — the batch catalog's subjects for the student's selected/primary batch.
 * Single source of truth for every student-facing subject list (arena/recordings/class-notes/lectures
 * read this instead of deriving subjects from content). Honors the ?batch_id header switch.
 */
async function subjects(req, res) {
  const student = await Student.findById(req.user.sub).select("batch_id section_id enrollment_number").lean();
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  await scopeStudentToBatch(req, student);
  const batchId = String(student.batch_id || "").trim().toLowerCase();
  return sendSuccess(res, batchId ? await catalogSubjects(batchId) : []);
}

module.exports = {
  getMe,
  patchMe,
  subjects,
  uploadAvatar,
  changePassword,
  sendPasswordUpdateOtp,
  verifyPasswordUpdateOtp,
  updatePasswordWithOtp,
};
