const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const { augmentStudentCatalogFieldsFromEnrollment } = require("../utils/enrollment");
const {
  isCloudinaryConfigured,
  uploadBufferToFolder,
  buildStudentAvatarFolder,
} = require("../utils/cloudinary");
const { getUploadsRoot } = require("../utils/upload-paths");

const uploadsRoot = getUploadsRoot();
const avatarsDir = path.join(uploadsRoot, "avatars");

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
  let avatar_url;

  if (isCloudinaryConfigured()) {
    try {
      const folder = buildStudentAvatarFolder(studentId);
      const result = await uploadBufferToFolder(req.file.buffer, "image", folder);
      avatar_url = result.secure_url || result.url;
    } catch (e) {
      return sendError(res, 500, "AVATAR_UPLOAD_FAILED", e.message || "Avatar upload failed");
    }
  } else {
    fs.mkdirSync(avatarsDir, { recursive: true });
    const ext = path.extname(req.file.originalname || "") || ".jpg";
    const id = String(studentId || "").replace(/[^a-f0-9]/gi, "");
    const filename = `student-${id || "x"}-${Date.now()}${ext}`;
    fs.writeFileSync(path.join(avatarsDir, filename), req.file.buffer);
    const rel = `/v1/static/avatars/${filename}`;
    avatar_url = `${req.protocol}://${req.get("host")}${rel}`;
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
  await student.save();
  return sendSuccess(res, {}, "Password updated");
}

module.exports = { getMe, patchMe, uploadAvatar, changePassword };
