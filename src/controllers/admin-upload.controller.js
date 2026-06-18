const { sendSuccess, sendError } = require("../utils/response");
const {
  isCloudinaryConfigured,
  uploadBuffer,
  uploadAssignmentBuffer,
  uploadBufferToFolder,
  buildNotesUploadFolder,
  buildAssignmentUploadFolder,
  buildAssignmentQuestionUploadFolder,
  buildBadgeProgramUploadFolder,
} = require("../utils/cloudinary");

function resourceTypeForAdminFile(mimetype) {
  if (/^image\/(jpeg|png|webp|gif)$/.test(mimetype || "")) return "image";
  if (/^video\/(mp4|quicktime|x-matroska|webm)$/.test(mimetype || "")) return "video";
  if (mimetype === "application/pdf") return "raw";
  return null;
}

async function uploadNoteAsset(req, res) {
  if (!isCloudinaryConfigured()) {
    return sendError(
      res,
      503,
      "CLOUDINARY_NOT_CONFIGURED",
      "Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET"
    );
  }
  if (!req.file?.buffer) {
    return sendError(res, 400, "FILE_REQUIRED", 'Expected multipart field "file"');
  }
  const resourceType = resourceTypeForAdminFile(req.file.mimetype);
  if (!resourceType) {
    return sendError(
      res,
      400,
      "INVALID_FILE",
      "Only JPEG, PNG, WebP, GIF images, MP4/MOV/MKV/WEBM videos, or PDF files are allowed"
    );
  }
  try {
    const folder = buildNotesUploadFolder(resourceType);
    const result = await uploadBuffer(req.file.buffer, {
      resourceType,
      filenameOverride: req.file.originalname || "",
    });
    return sendSuccess(
      res,
      {
        url: result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type,
        bytes: result.bytes ?? req.file.size,
        format: result.format,
        folder: result.folder || folder,
        context: "notes",
      },
      "Uploaded"
    );
  } catch (e) {
    return sendError(res, 500, "CLOUDINARY_UPLOAD_FAILED", e.message || "Upload failed", {
      name: e.name,
    });
  }
}

async function uploadAssignmentAsset(req, res) {
  if (!isCloudinaryConfigured()) {
    return sendError(
      res,
      503,
      "CLOUDINARY_NOT_CONFIGURED",
      "Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET"
    );
  }
  if (!req.file?.buffer) {
    return sendError(res, 400, "FILE_REQUIRED", 'Expected multipart field "file"');
  }
  const resourceType = resourceTypeForAdminFile(req.file.mimetype);
  if (!resourceType) {
    return sendError(
      res,
      400,
      "INVALID_FILE",
      "Only JPEG, PNG, WebP, GIF images, MP4/MOV/MKV/WEBM videos, or PDF files are allowed"
    );
  }
  try {
    const folder = buildAssignmentUploadFolder(resourceType);
    const result = await uploadAssignmentBuffer(req.file.buffer, {
      resourceType,
      filenameOverride: req.file.originalname || "",
    });
    return sendSuccess(
      res,
      {
        url: result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type,
        bytes: result.bytes ?? req.file.size,
        format: result.format,
        folder: result.folder || folder,
        context: "assignments",
      },
      "Uploaded"
    );
  } catch (e) {
    return sendError(res, 500, "CLOUDINARY_UPLOAD_FAILED", e.message || "Upload failed", {
      name: e.name,
    });
  }
}

async function uploadAssignmentQuestionAsset(req, res) {
  if (!isCloudinaryConfigured()) {
    return sendError(
      res,
      503,
      "CLOUDINARY_NOT_CONFIGURED",
      "Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET"
    );
  }
  if (!req.file?.buffer) {
    return sendError(res, 400, "FILE_REQUIRED", 'Expected multipart field "file"');
  }
  const resourceType = resourceTypeForAdminFile(req.file.mimetype);
  if (resourceType !== "image" && resourceType !== "video") {
    return sendError(res, 400, "INVALID_FILE", "Only images (JPEG/PNG/WebP/GIF) or videos (MP4/MOV/MKV/WEBM) are allowed for question media");
  }
  try {
    const folder = buildAssignmentQuestionUploadFolder(resourceType);
    const result = await uploadBufferToFolder(req.file.buffer, resourceType, folder, {
      filenameOverride: req.file.originalname || "",
    });
    return sendSuccess(
      res,
      {
        url: result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type,
        bytes: result.bytes ?? req.file.size,
        format: result.format,
        folder: result.folder || folder,
        context: "assignment-questions",
      },
      "Uploaded"
    );
  } catch (e) {
    return sendError(res, 500, "CLOUDINARY_UPLOAD_FAILED", e.message || "Upload failed", {
      name: e.name,
    });
  }
}

async function uploadBadgeProgramArt(req, res) {
  if (!isCloudinaryConfigured()) {
    return sendError(
      res,
      503,
      "CLOUDINARY_NOT_CONFIGURED",
      "Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET"
    );
  }
  if (!req.file?.buffer) {
    return sendError(res, 400, "FILE_REQUIRED", 'Expected multipart field "file"');
  }
  const resourceType = resourceTypeForAdminFile(req.file.mimetype);
  if (resourceType !== "image") {
    return sendError(res, 400, "INVALID_FILE", "Only JPEG, PNG, WebP, GIF images are allowed for badge artwork");
  }
  try {
    const folder = buildBadgeProgramUploadFolder("image");
    const result = await uploadBufferToFolder(req.file.buffer, "image", folder, {
      filenameOverride: req.file.originalname || "",
    });
    return sendSuccess(
      res,
      {
        url: result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type,
        bytes: result.bytes ?? req.file.size,
        format: result.format,
        folder: result.folder || folder,
        context: "badge-programs",
      },
      "Uploaded"
    );
  } catch (e) {
    return sendError(res, 500, "CLOUDINARY_UPLOAD_FAILED", e.message || "Upload failed", {
      name: e.name,
    });
  }
}

module.exports = {
  uploadNoteAsset,
  uploadAssignmentAsset,
  uploadAssignmentQuestionAsset,
  uploadBadgeProgramArt,
};
