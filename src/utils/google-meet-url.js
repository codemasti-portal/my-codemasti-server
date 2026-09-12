const { z } = require("zod");

const GOOGLE_MEET_URL_MESSAGE =
  "Must be a valid Google Meet link (https://meet.google.com/your-meeting-code)";

/**
 * Normalize and validate a Google Meet URL.
 * Accepts https://meet.google.com/... with a single non-empty path segment (meeting code).
 * Rejects empty values, non-HTTPS, other hosts, and unrelated Google URLs.
 *
 * @returns {string | null} trimmed URL when valid, otherwise null
 */
function parseGoogleMeetUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "meet.google.com") return null;
  const segment = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!segment || segment.includes("/")) return null;
  if (!/^[\w-]+$/i.test(segment)) return null;
  // Canonical stored form — trailing slashes and harmless query/hash are accepted on input.
  return `https://meet.google.com/${segment}`;
}

function isValidGoogleMeetUrl(value) {
  return parseGoogleMeetUrl(value) !== null;
}

/** Required Google Meet URL (create flows). */
const zGoogleMeetUrlRequired = () =>
  z
    .string()
    .trim()
    .min(1, "Google Meet link is required")
    .refine(isValidGoogleMeetUrl, { message: GOOGLE_MEET_URL_MESSAGE });

/**
 * PATCH semantics — omit to preserve; supplied non-empty must be valid; empty string rejected.
 */
const zGoogleMeetUrlPatch = () =>
  z
    .string()
    .trim()
    .optional()
    .refine((v) => v === undefined || (v.length > 0 && isValidGoogleMeetUrl(v)), {
      message: GOOGLE_MEET_URL_MESSAGE,
    });

module.exports = {
  GOOGLE_MEET_URL_MESSAGE,
  parseGoogleMeetUrl,
  isValidGoogleMeetUrl,
  zGoogleMeetUrlRequired,
  zGoogleMeetUrlPatch,
};
