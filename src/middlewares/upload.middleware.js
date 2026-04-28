const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { getUploadsRoot } = require("../utils/upload-paths");

const uploadsRoot = getUploadsRoot();
const avatarsDir = path.join(uploadsRoot, "avatars");
const doubtImagesDir = path.join(uploadsRoot, "doubt-images");
const staffImagesDir = path.join(uploadsRoot, "staff-profile-images");
const staffResumesDir = path.join(uploadsRoot, "staff-resumes");

function ensureDirs() {
  fs.mkdirSync(avatarsDir, { recursive: true });
  fs.mkdirSync(doubtImagesDir, { recursive: true });
  fs.mkdirSync(staffImagesDir, { recursive: true });
  fs.mkdirSync(staffResumesDir, { recursive: true });
}

ensureDirs();

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `${req.user.sub}-${Date.now()}${ext}`);
  },
});

exports.avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif images are allowed"));
  },
}).single("file");

const studentAvatarMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif images are allowed"));
  },
});

/** Admin student photo → memory; controller writes disk or Cloudinary. Field name: file */
exports.adminStudentAvatarUpload = studentAvatarMemory.single("file");

/** Student app POST /me/avatar — same as admin (memory + Cloudinary or disk). Field name: file */
exports.studentSelfAvatarUpload = studentAvatarMemory.single("file");

const doubtStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, doubtImagesDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `${req.user.sub}-${Date.now()}${ext}`);
  },
});

exports.doubtImageUpload = multer({
  storage: doubtStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image uploads are allowed"));
  },
}).single("image");

const staffImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, staffImagesDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `staff-${req.user.sub}-${Date.now()}${ext}`);
  },
});

exports.staffProfileImageUpload = multer({
  storage: staffImageStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif images are allowed"));
  },
}).single("file");

const staffResumeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, staffResumesDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".pdf";
    cb(null, `resume-${req.user.sub}-${Date.now()}${ext}`);
  },
});

exports.staffResumeUpload = multer({
  storage: staffResumeStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdfMime = file.mimetype === "application/pdf";
    const isPdfName = /\.pdf$/i.test(file.originalname || "");
    if (isPdfMime || isPdfName) cb(null, true);
    else cb(new Error("Only PDF resumes are allowed"));
  },
}).single("file");

const adminCloudinaryFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ||
      /^video\/(mp4|quicktime|x-matroska|webm)$/.test(file.mimetype) ||
      file.mimetype === "application/pdf"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only images, videos (mp4, mov, mkv, webm), or PDF files are allowed"));
    }
  },
}).single("file");

/** Notes → Cloudinary under codemasti/notes/... Field name: file */
exports.noteAssetUpload = adminCloudinaryFile;

/** Assignment handouts → Cloudinary under codemasti/assignments/... Field name: file */
exports.assignmentAssetUpload = adminCloudinaryFile;

const communityMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ||
      /^video\/(mp4|quicktime|x-matroska|webm)$/.test(file.mimetype) ||
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/msword" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.mimetype === "text/plain" ||
      file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported media type. Allowed: image, video, pdf, doc, docx, txt, zip"));
    }
  },
}).single("file");

/** Staff community chat attachments. Field name: file */
exports.communityMediaUpload = communityMediaUpload;
