const crypto = require("crypto");

/** Lazy-load so API boots without Calendar credentials or before `npm install googleapis`. */
function loadGoogleApis() {
  try {
    return require("googleapis");
  } catch {
    return null;
  }
}

function getOAuthClient() {
  const goog = loadGoogleApis();
  if (!goog) return null;
  const cid = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const cs = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const rt = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
  if (!cid || !cs || !rt) return null;
  const { google } = goog;
  const oauth2 = new google.auth.OAuth2(cid, cs, "urn:ietf:wg:oauth:2.0:oob");
  oauth2.setCredentials({ refresh_token: rt });
  return oauth2;
}

function isGoogleMeetCalendarConfigured() {
  const goog = loadGoogleApis();
  const { google } = goog || {};
  return Boolean(
    google &&
      process.env.GOOGLE_CALENDAR_CLIENT_ID &&
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
      process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  );
}

function padTimePart(seg) {
  const [h, m] = String(seg || "").trim().split(":");
  const hh = String(Math.min(23, Math.max(0, Number.parseInt(h, 10) || 0))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, Number.parseInt(m, 10) || 0))).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Parses slot `time` like "09:00 – 10:00" or "09:00-10:30" into { startHm, endHm }
 * @returns {{ startHm: string, endHm: string } | null}
 */
function parseTimetableTimeRange(rangeStr) {
  const s = String(rangeStr || "").trim();
  const m = s.match(/^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  return { startHm: padTimePart(m[1]), endHm: padTimePart(m[2]) };
}

function buildDateTime(dateYmd, hm, timeZone) {
  const d = `${String(dateYmd).trim()}T${hm}:00`;
  /** RFC3339 with explicit offset avoids ambiguous local interpretation in API payloads. */
  return { dateTime: d, timeZone: timeZone || "UTC" };
}

/**
 * @param {{
 *   title: string,
 *   description?: string,
 *   dateYmd: string,
 *   timeRange: string,
 *   attendeeEmails: string[],
 * }} opts
 * @returns {Promise<{ meetLink: string, htmlLink: string, eventId: string, attendeeEmails: string[] }>}
 */
async function createMeetCalendarEvent(opts) {
  const goog = loadGoogleApis();
  if (!goog) {
    throw new Error("Calendar integration requires the `googleapis` package (npm install googleapis).");
  }
  const { google } = goog;
  const auth = getOAuthClient();
  if (!auth) throw new Error("Google Calendar OAuth is not configured on the server");

  const { title, description = "", dateYmd, timeRange, attendeeEmails } = opts;
  const tz =
    process.env.GOOGLE_CALENDAR_TIME_ZONE || process.env.GOOGLE_CALENDAR_TIMEZONE || "Asia/Kolkata";
  const range = parseTimetableTimeRange(timeRange);
  if (!range) {
    throw new Error('Could not parse time range. Use formats like "09:00 – 10:30"');
  }

  const start = buildDateTime(dateYmd, range.startHm, tz);
  const end = buildDateTime(dateYmd, range.endHm, tz);

  const uniq = [...new Set((attendeeEmails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  /** Google warns above ~optional - cap to stay within limits */
  const capped = uniq.slice(0, 499);

  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  const requestId = crypto.randomBytes(16).toString("hex");

  const res = await calendar.events.insert({
    calendarId,
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary: String(title || "").trim() || "CodeMasti class",
      description: String(description || "").trim(),
      start,
      end,
      guestsCanModify: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true,
      attendees: capped.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const data = res.data || {};
  const meetLink =
    data.hangoutLink ||
    (data.conferenceData &&
      Array.isArray(data.conferenceData.entryPoints) &&
      (
        data.conferenceData.entryPoints.find((ep) => String(ep.entryPointType || "") === "video") ||
        data.conferenceData.entryPoints[0]
      )?.uri) ||
    "";
  const htmlLink = data.htmlLink || "";
  const eventId = data.id || "";

  if (!meetLink) {
    throw new Error(
      "Calendar event was created but no Meet link was returned. Ensure the Calendar account supports Google Meet and Calendar API Meet creation is enabled for the GCP project."
    );
  }

  return { meetLink, htmlLink, eventId, attendeeEmails: capped };
}

module.exports = {
  isGoogleMeetCalendarConfigured,
  parseTimetableTimeRange,
  createMeetCalendarEvent,
};
