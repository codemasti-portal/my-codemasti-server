/** Minutes before class start — skip generic schedule notification; use class reminder instead. */
const IMMINENT_CLASS_MINUTES = 15;

/**
 * Pad single-digit minutes in time strings: "12:5" → "12:05"
 */
function normalizeTimeString(raw) {
  return String(raw || "")
    .trim()
    .replace(/:(\d)(?!\d)/g, ":0$1");
}

/**
 * Parse class_date + time label into a local Date, or null.
 * Supports 24h "11:35-12:05" / "11:35 – 12:05" and 12h "09:00 AM - 10:00 AM".
 */
function parseSlotStart(classDateStr, timeLabel) {
  const rawDate = String(classDateStr || "").trim();
  if (!rawDate) return null;
  const [y, m, d] = rawDate.slice(0, 10).split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

  const raw = normalizeTimeString(timeLabel);
  const m24 = raw.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (m24) return new Date(y, m - 1, d, Number(m24[1]), Number(m24[2]), 0, 0);

  const m12 = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m12) {
    let hh = Number(m12[1]);
    const mm = Number(m12[2]);
    const period = String(m12[3]).toUpperCase();
    if (period === "AM") {
      if (hh === 12) hh = 0;
    } else if (hh !== 12) {
      hh += 12;
    }
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }
  return null;
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
  normalizeTimeString,
  parseSlotStart,
  minutesUntilClassStart,
  isClassImminent,
  isClassInFuture,
  buildClassStartReminderCopy,
  timetableScheduleTitle,
  timetableScheduleBody,
};
