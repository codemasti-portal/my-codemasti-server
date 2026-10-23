const multer = require("multer");

// All uploads are buffered in memory and sent to Cloudinary; nothing is written to local disk.

const studentAvatarMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif images are allowed"));
  },
});

/** Admin student photo → memory → Cloudinary. Field name: file */
exports.adminStudentAvatarUpload = studentAvatarMemory.single("file");

/** Student app POST /me/avatar — same as admin (memory → Cloudinary). Field name: file */
exports.studentSelfAvatarUpload = studentAvatarMemory.single("file");

exports.doubtImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image uploads are allowed"));
  },
}).single("image");

exports.staffProfileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif images are allowed"));
  },
}).single("file");

/** Manual UPI payment proof screenshot → memory → Cloudinary. Field name: screenshot */
exports.paymentProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif screenshots are allowed"));
  },
}).single("screenshot");

exports.staffResumeUpload = multer({
  storage: multer.memoryStorage(),
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

const badgeProgramArtUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only jpeg, png, webp, or gif images are allowed for badge art"));
  },
}).single("file");

/** Badge program custom artwork → Cloudinary. Field name: file */
exports.badgeProgramArtUpload = badgeProgramArtUpload;

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
