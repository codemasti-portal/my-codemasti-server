const { z } = require("zod");

const GOOGLE_DRIVE_FOLDER_URL_MESSAGE =
  "Must be a valid Google Drive folder link (https://drive.google.com/drive/folders/...)";

/** Folder ids are opaque tokens; allow common Drive id characters. */
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Parse and normalize a Google Drive folder URL.
 * Accepts https://drive.google.com/drive/folders/{id} and /drive/u/{n}/folders/{id} forms.
 * Preserves `resourcekey` when present; strips presentation params like usp=sharing.
 *
 * @returns {{ url: string, folderId: string, resourceKey: string | null } | null}
 */
function parseGoogleDriveFolderUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "drive.google.com") return null;

  const path = parsed.pathname.replace(/\/+$/g, "");
  const folderMatch = path.match(/\/drive(?:\/u\/\d+)?\/folders\/([^/]+)$/);
  if (!folderMatch) return null;

  const folderId = folderMatch[1];
  if (!folderId || !FOLDER_ID_RE.test(folderId)) return null;

  const resourceKey = parsed.searchParams.get("resourcekey");
  let url = `https://drive.google.com/drive/folders/${folderId}`;
  if (resourceKey) {
    url += `?resourcekey=${encodeURIComponent(resourceKey)}`;
  }

  return {
    url,
    folderId,
    resourceKey: resourceKey || null,
  };
}

function isValidGoogleDriveFolderUrl(value) {
  return parseGoogleDriveFolderUrl(value) !== null;
}

/**
 * Normalize admin input: empty clears; non-empty must parse.
 * @returns {string} normalized URL or ""
 */
function normalizeGoogleDriveFolderUrlInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = parseGoogleDriveFolderUrl(raw);
  if (!parsed) {
    throw new Error(GOOGLE_DRIVE_FOLDER_URL_MESSAGE);
  }
  return parsed.url;
}

/** Optional on create — omit or empty allowed; non-empty must be valid. */
const zGoogleDriveFolderUrlCreate = () =>
  z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || v === "" || isValidGoogleDriveFolderUrl(v), {
      message: GOOGLE_DRIVE_FOLDER_URL_MESSAGE,
    });

/**
 * PATCH semantics — omit to preserve; empty string clears; non-empty must be valid.
 */
const zGoogleDriveFolderUrlPatch = () =>
  z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || v === "" || isValidGoogleDriveFolderUrl(v), {
      message: GOOGLE_DRIVE_FOLDER_URL_MESSAGE,
    });

module.exports = {
  GOOGLE_DRIVE_FOLDER_URL_MESSAGE,
  parseGoogleDriveFolderUrl,
  isValidGoogleDriveFolderUrl,
  normalizeGoogleDriveFolderUrlInput,
  zGoogleDriveFolderUrlCreate,
  zGoogleDriveFolderUrlPatch,
};
