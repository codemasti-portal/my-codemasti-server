/** Minutes before class start — skip generic schedule notification; use class reminder instead. */
const IMMINENT_CLASS_MINUTES = 15;

/**
 * IANA timezone the class_date + time strings are written in (e.g. "11:35-12:05" means
 * 11:35 in this zone). Defaults to Asia/Kolkata. MUST NOT depend on the server's own
 * timezone — Vercel runs functions in UTC, so naive parsing would be off by the offset.
 */
function getClassTimeZone() {
  return (
    String(process.env.CLASS_TIMEZONE || process.env.GOOGLE_CALENDAR_TIME_ZONE || "Asia/Kolkata").trim() ||
    "Asia/Kolkata"
  );
}

/** Offset (ms) of `timeZone` from UTC at the given UTC instant. e.g. Asia/Kolkata → +19800000 (5h30m). */
function zoneOffsetMs(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asIfUtc - utcMs;
}

/**
 * Convert wall-clock components (meant to be in `timeZone`) to the correct UTC Date.
 * Works on any server timezone. (Asia/Kolkata has no DST, so the offset is exact.)
 */
function wallTimeInZoneToDate(y, m, d, hh, mm, timeZone) {
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const offsetMs = zoneOffsetMs(timeZone, utcGuess);
  return new Date(utcGuess - offsetMs);
}

/**
 * Pad single-digit minutes in time strings: "12:5" → "12:05"
 */
function normalizeTimeString(raw) {
  return String(raw || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/:(\d)(?!\d)/g, ":0$1");
}

/**
 * Parse class_date + time label into a UTC Date (interpreting the wall time in the
 * class timezone), or null. Supports 24h "11:35-12:05" / "11:35 – 12:05" and
 * 12h "09:00 AM - 10:00 AM".
 */
function parseSlotStart(classDateStr, timeLabel) {
  const rawDate = String(classDateStr || "").trim();
  if (!rawDate) return null;
  const [y, m, d] = rawDate.slice(0, 10).split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

  const tz = getClassTimeZone();
  const raw = normalizeTimeString(timeLabel);
  const parse12hStart = raw.match(/^\s*(\d{1,2}):([0-5]\d)\s*(AM|PM)\b/i);
  if (parse12hStart) {
    let hh = Number(parse12hStart[1]);
    const mm = Number(parse12hStart[2]);
    const period = String(parse12hStart[3]).toUpperCase();
    if (hh < 1 || hh > 12) return null;
    if (period === "AM") {
      if (hh === 12) hh = 0;
    } else if (hh !== 12) {
      hh += 12;
    }
    return wallTimeInZoneToDate(y, m, d, hh, mm, tz);
  }

  const parse24hStart = raw.match(/^\s*([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (parse24hStart) {
    return wallTimeInZoneToDate(y, m, d, Number(parse24hStart[1]), Number(parse24hStart[2]), tz);
  }
  return null;
}

/**
 * Parse the scheduled END of a class from class_date + time range label, or null if unparseable.
 * Supports 24h "11:35-12:05" and 12h "09:00 AM - 10:30 AM" (end segment after the hyphen).
 */
function parseSlotEnd(classDateStr, timeLabel) {
  const rawDate = String(classDateStr || "").trim();
  if (!rawDate) return null;
  const [y, m, d] = rawDate.slice(0, 10).split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

  const tz = getClassTimeZone();
  const raw = normalizeTimeString(timeLabel);

  const parse12hEnd = raw.match(/-\s*(\d{1,2}):([0-5]\d)\s*(AM|PM)\b/i);
  if (parse12hEnd) {
    let hh = Number(parse12hEnd[1]);
    const mm = Number(parse12hEnd[2]);
    const period = String(parse12hEnd[3]).toUpperCase();
    if (hh < 1 || hh > 12) return null;
    if (period === "AM") {
      if (hh === 12) hh = 0;
    } else if (hh !== 12) {
      hh += 12;
    }
    return wallTimeInZoneToDate(y, m, d, hh, mm, tz);
  }

  // 24:00 as end time = midnight at the start of the following calendar day (not 00:00 same day).
  const parse24hHour24End = raw.match(/-\s*24:([0-5]\d)\s*$/);
  if (parse24hHour24End) {
    if (parse24hHour24End[1] !== "00") return null;
    const nextCal = new Date(Date.UTC(y, m - 1, d));
    nextCal.setUTCDate(nextCal.getUTCDate() + 1);
    return wallTimeInZoneToDate(
      nextCal.getUTCFullYear(),
      nextCal.getUTCMonth() + 1,
      nextCal.getUTCDate(),
      0,
      0,
      tz
    );
  }

  const parse24hEnd = raw.match(/-\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/);
  if (parse24hEnd) {
    return wallTimeInZoneToDate(y, m, d, Number(parse24hEnd[1]), Number(parse24hEnd[2]), tz);
  }

  return null;
}

function formatDateYmdInClassTimeZone(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return "";
  const tz = getClassTimeZone();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  if (!map.year || !map.month || !map.day) return "";
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * @returns {number | null} Whole minutes until start; negative if already started; null if unparseable.
 */
function minutesUntilClassStart(slot, at = new Date()) {
  const startsAt = parseSlotStart(slot?.class_date, slot?.time);
  if (!startsAt) return null;
  return Math.round((startsAt.getTime() - at.getTime()) / 60_000);
}

function isClassImminent(slot, at = new Date()) {
  const mins = minutesUntilClassStart(slot, at);
  if (mins === null) return false;
  return mins > 0 && mins <= IMMINENT_CLASS_MINUTES;
}

function isClassInFuture(slot, at = new Date()) {
  const mins = minutesUntilClassStart(slot, at);
  return mins !== null && mins > 0;
}

/**
 * Human-friendly title + body for the ~10-minute (or sooner) class reminder.
 */
function buildClassStartReminderCopy(minutesUntil, slot, whenText) {
  const subject = String(slot?.subject || "Class").trim();
  const when = whenText || "";
  if (minutesUntil <= 1) {
    return {
      title: "Class starting now",
      body: `Your class ${subject} is starting now${when ? ` (${when})` : ""}.`,
    };
  }
  if (minutesUntil < 10) {
    return {
      title: "Class starts soon",
      body: `Your class ${subject} starts in ${minutesUntil} minutes${when ? ` (${when})` : ""}.`,
    };
  }
  return {
    title: "Class starts in 10 minutes",
    body: `Your class ${subject} starts in 10 minutes${when ? ` (${when})` : ""}.`,
  };
}

function timetableScheduleTitle(action) {
  if (action === "created") return "New class scheduled";
  if (action === "deleted") return "Class cancelled";
  return "Class schedule updated";
}

function timetableScheduleBody(slot, action) {
  const subject = String(slot?.subject || "Class").trim();
  const day = String(slot?.day || "").trim();
  const time = String(slot?.time || "").trim();
  const teacher = String(slot?.teacher || "").trim();
  const when = [day, time].filter(Boolean).join(" · ");
  const withTeacher = teacher ? ` with ${teacher}` : "";

  if (action === "created") {
    return `${subject}${when ? ` — ${when}` : ""}${withTeacher}. Open your timetable to see details.`;
  }
  if (action === "deleted") {
    return `${subject}${when ? ` (${when})` : ""}${withTeacher} was cancelled.`;
  }
  return `${subject} schedule was updated${when ? ` — ${when}` : ""}${withTeacher}.`;
}

module.exports = {
  IMMINENT_CLASS_MINUTES,
  getClassTimeZone,
  normalizeTimeString,
  parseSlotStart,
  parseSlotEnd,
  formatDateYmdInClassTimeZone,
  minutesUntilClassStart,
  isClassImminent,
  isClassInFuture,
  buildClassStartReminderCopy,
  timetableScheduleTitle,
  timetableScheduleBody,
};
