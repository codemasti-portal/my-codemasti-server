/**
 * Leaderboard time windows and Student of the Month periods use IST (Asia/Kolkata, UTC+05:30, no DST).
 * Mongo dates are stored in UTC; we compare against the correct UTC instants for IST midnight boundaries.
 */

const TZ = "Asia/Kolkata";

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * IST calendar month as [start, end) in absolute time (end is first instant of next IST month).
 */
function indiaMonthBoundsUtc(year, month1to12) {
  const y = Number(year);
  const m = Number(month1to12);
  const start = new Date(`${y}-${pad(m)}-01T00:00:00+05:30`);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = new Date(`${nextY}-${pad(nextM)}-01T00:00:00+05:30`);
  return { start, end };
}

/** Match `submitted_at` for one India calendar month (period label YYYY-MM = month in IST). */
function submittedAtIndiaCalendarMonth(year, month1to12) {
  const { start, end } = indiaMonthBoundsUtc(year, month1to12);
  return { submitted_at: { $gte: start, $lt: end } };
}

function indiaYearMonthFromDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  return { year: y, month: m };
}

function indiaYmdFromDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

function indiaThisMonthSubmittedMatch(now = new Date()) {
  const { year, month } = indiaYearMonthFromDate(now);
  return submittedAtIndiaCalendarMonth(year, month);
}

function indiaThisYearSubmittedMatch(now = new Date()) {
  const { year } = indiaYearMonthFromDate(now);
  const start = new Date(`${year}-01-01T00:00:00+05:30`);
  const end = new Date(`${year + 1}-01-01T00:00:00+05:30`);
  return { submitted_at: { $gte: start, $lt: end } };
}

/** Start of the current Monday-00:00-IST week, as an absolute instant. */
function indiaWeekStartInstant(now = new Date()) {
  const { year, month, day } = indiaYmdFromDate(now);
  const startOfTodayIst = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00+05:30`);
  const wk = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(startOfTodayIst);
  const mon0 = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[wk] ?? 0;
  return new Date(startOfTodayIst.getTime() - mon0 * 86400000);
}

/** Week starts Monday 00:00 IST. */
function indiaThisWeekSubmittedMatch(now = new Date()) {
  const weekStart = indiaWeekStartInstant(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
  return { submitted_at: { $gte: weekStart, $lt: weekEnd } };
}

/** Stable "YYYY-MM-DD" key (the Monday date) identifying the current IST week — used to dedupe
 * weekly-scoped awards (e.g. "Closed the Gap", "The Climb") without a separate period table. */
function indiaWeekKey(now = new Date()) {
  return toIndiaCalendarYmd(indiaWeekStartInstant(now));
}

/** Exclusive end instant for period "YYYY-MM" in IST (= eligible to finalize once `now >=` this). */
function indianPeriodFirstInstantAfterClosed(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const { end } = indiaMonthBoundsUtc(y, mo);
  return end;
}

function isIndianCalendarPeriodEligibleForFinalization(period, nowDate = new Date()) {
  const endExclusive = indianPeriodFirstInstantAfterClosed(period);
  if (!endExclusive) return false;
  return nowDate >= endExclusive;
}

/** Last `count` full IST calendar months strictly before `now`'s IST month. */
function recentClosedIndianMonthPeriods(count, nowDate = new Date()) {
  const out = [];
  let { year, month } = indiaYearMonthFromDate(nowDate);
  month -= 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  for (let i = 0; i < count; i += 1) {
    out.push(`${year}-${pad(month)}`);
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

/** IST calendar date YYYY-MM-DD for instant `input`. */
function toIndiaCalendarYmd(input = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(input));
  const pick = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

module.exports = {
  TZ,
  indiaMonthBoundsUtc,
  submittedAtIndiaCalendarMonth,
  indiaYearMonthFromDate,
  indiaThisMonthSubmittedMatch,
  indiaThisYearSubmittedMatch,
  indiaThisWeekSubmittedMatch,
  indiaWeekStartInstant,
  indiaWeekKey,
  indianPeriodFirstInstantAfterClosed,
  isIndianCalendarPeriodEligibleForFinalization,
  recentClosedIndianMonthPeriods,
  toIndiaCalendarYmd,
};
