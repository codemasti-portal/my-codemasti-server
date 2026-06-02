const cloudinary = require("cloudinary").v2;

function isCloudinaryConfigured() {
  if (process.env.CLOUDINARY_URL && String(process.env.CLOUDINARY_URL).trim()) return true;
  const n = process.env.CLOUDINARY_CLOUD_NAME;
  const k = process.env.CLOUDINARY_API_KEY;
  const s = process.env.CLOUDINARY_API_SECRET;
  return !!(n && k && s);
}

function ensureCloudinaryConfig() {
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config();
    return;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function buildDatedSubfolder(rootDefault, rootEnvKey, useDateEnvKey, resourceType) {
  const root = (process.env[rootEnvKey] || rootDefault).replace(/^\/+|\/+$/g, "");
  const kind = resourceType === "image" ? "images" : resourceType === "video" ? "videos" : "pdfs";
  const useDate = !/^(false|0)$/i.test(String(process.env[useDateEnvKey] || "true"));
  if (!useDate) {
    return `${root}/${kind}`;
  }
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${root}/${kind}/${y}/${m}`;
}

/**
 * Notes: {root}/images/YYYY/MM and {root}/pdfs/YYYY/MM
 * CLOUDINARY_NOTES_FOLDER (default codemasti/notes), CLOUDINARY_NOTES_USE_DATE
 */
function buildNotesUploadFolder(resourceType) {
  return buildDatedSubfolder("codemasti/notes", "CLOUDINARY_NOTES_FOLDER", "CLOUDINARY_NOTES_USE_DATE", resourceType);
}

/**
 * Assignments handouts: {root}/images/YYYY/MM and {root}/pdfs/YYYY/MM
 * CLOUDINARY_ASSIGNMENTS_FOLDER (default codemasti/assignments), CLOUDINARY_ASSIGNMENTS_USE_DATE
 */
function buildAssignmentUploadFolder(resourceType) {
  return buildDatedSubfolder(
    "codemasti/assignments",
    "CLOUDINARY_ASSIGNMENTS_FOLDER",
    "CLOUDINARY_ASSIGNMENTS_USE_DATE",
    resourceType
  );
}

/**
 * Assignment question media: {root}/images/YYYY/MM
 * CLOUDINARY_ASSIGNMENT_QUESTIONS_FOLDER (default codemasti/assignments/questions)
 * CLOUDINARY_ASSIGNMENT_QUESTIONS_USE_DATE
 */
function buildAssignmentQuestionUploadFolder(resourceType) {
  return buildDatedSubfolder(
    "codemasti/assignments/questions",
    "CLOUDINARY_ASSIGNMENT_QUESTIONS_FOLDER",
    "CLOUDINARY_ASSIGNMENT_QUESTIONS_USE_DATE",
    resourceType
  );
}

/**
 * Community chat uploads:
 * {root}/images|videos|files/YYYY/MM
 * CLOUDINARY_COMMUNITY_FOLDER (default codemasti/community)
 * CLOUDINARY_COMMUNITY_USE_DATE
 */
function buildCommunityUploadFolder(resourceType) {
  const root = (process.env.CLOUDINARY_COMMUNITY_FOLDER || "codemasti/community").replace(/^\/+|\/+$/g, "");
  const kind = resourceType === "image" ? "images" : resourceType === "video" ? "videos" : "files";
  const useDate = !/^(false|0)$/i.test(String(process.env.CLOUDINARY_COMMUNITY_USE_DATE || "true"));
  if (!useDate) return `${root}/${kind}`;
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${root}/${kind}/${y}/${m}`;
}

/**
 * Doubts (personal) images:
 * {root}/images/YYYY/MM
 * CLOUDINARY_DOUBTS_FOLDER (default codemasti/doubts), CLOUDINARY_DOUBTS_USE_DATE
 */
function buildDoubtsUploadFolder(resourceType) {
  return buildDatedSubfolder("codemasti/doubts", "CLOUDINARY_DOUBTS_FOLDER", "CLOUDINARY_DOUBTS_USE_DATE", resourceType);
}

function sanitizeStudentIdForFolder(id) {
  const s = String(id ?? "").replace(/[^a-f0-9]/gi, "");
  return s || "unknown";
}

/**
 * One Cloudinary folder per student (profile photos only).
 * Root: CLOUDINARY_STUDENTS_ROOT (default codemasti/students)
 * Path: {root}/profiles/{mongoObjectId}
 */
function buildStudentAvatarFolder(studentId) {
  const root = (process.env.CLOUDINARY_STUDENTS_ROOT || "codemasti/students").replace(/^\/+|\/+$/g, "");
  const seg = sanitizeStudentIdForFolder(studentId);
  return `${root}/profiles/${seg}`;
}

function sanitizeStaffIdForFolder(id) {
  const s = String(id ?? "").replace(/[^a-f0-9]/gi, "");
  return s || "unknown";
}

/**
 * One Cloudinary folder per staff member (profile photos + resumes).
 * Root: CLOUDINARY_STAFF_ROOT (default codemasti/staff)
 * Path: {root}/profiles/{mongoObjectId}
 */
function buildStaffProfileFolder(staffId) {
  const root = (process.env.CLOUDINARY_STAFF_ROOT || "codemasti/staff").replace(/^\/+|\/+$/g, "");
  const seg = sanitizeStaffIdForFolder(staffId);
  return `${root}/profiles/${seg}`;
}

function sanitizeFilename(name) {
  return String(name || "")
    .replace(/[^\w.\- ]+/g, "")
    .trim();
}

/**
 * @param {Buffer} buffer
 * @param {'image' | 'raw'} resourceType
 * @param {string} folder Cloudinary folder path
 * @param {{ filenameOverride?: string }} [opts]
 */
function uploadBufferToFolder(buffer, resourceType, folder, opts = {}) {
  ensureCloudinaryConfig();
  const filenameOverride = sanitizeFilename(opts.filenameOverride);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        ...(filenameOverride ? { filename_override: filenameOverride } : {}),
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/**
 * @param {Buffer} buffer
 * @param {{ resourceType: 'image' | 'raw', filenameOverride?: string }} opts
 */
function uploadBuffer(buffer, opts) {
  const folder = buildNotesUploadFolder(opts.resourceType);
  return uploadBufferToFolder(buffer, opts.resourceType, folder, {
    filenameOverride: opts.filenameOverride,
  });
}

/**
 * @param {Buffer} buffer
 * @param {{ resourceType: 'image' | 'raw', filenameOverride?: string }} opts
 */
function uploadAssignmentBuffer(buffer, opts) {
  const folder = buildAssignmentUploadFolder(opts.resourceType);
  return uploadBufferToFolder(buffer, opts.resourceType, folder, {
    filenameOverride: opts.filenameOverride,
  });
}

function buildBadgeProgramUploadFolder(resourceType) {
  return buildDatedSubfolder(
    "codemasti/badge-programs",
    "CLOUDINARY_BADGE_PROGRAMS_FOLDER",
    "CLOUDINARY_BADGE_PROGRAMS_USE_DATE",
    resourceType
  );
}

/**
 * Manual UPI payment proof screenshots: {root}/images/YYYY/MM
 * CLOUDINARY_PAYMENT_PROOFS_FOLDER (default codemasti/payments/proofs), CLOUDINARY_PAYMENT_PROOFS_USE_DATE
 */
function buildPaymentProofUploadFolder(resourceType) {
  return buildDatedSubfolder(
    "codemasti/payments/proofs",
    "CLOUDINARY_PAYMENT_PROOFS_FOLDER",
    "CLOUDINARY_PAYMENT_PROOFS_USE_DATE",
    resourceType
  );
}

module.exports = {
  cloudinary,
  isCloudinaryConfigured,
  ensureCloudinaryConfig,
  uploadBuffer,
  uploadBufferToFolder,
  uploadAssignmentBuffer,
  buildNotesUploadFolder,
  buildAssignmentUploadFolder,
  buildAssignmentQuestionUploadFolder,
  buildBadgeProgramUploadFolder,
  buildPaymentProofUploadFolder,
  buildCommunityUploadFolder,
  buildDoubtsUploadFolder,
  buildStudentAvatarFolder,
  buildStaffProfileFolder,
};
