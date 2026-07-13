const Contest = require("../models/Contest");
const ScorecardTest = require("../models/ScorecardTest");
const { getContestPhase, countdownSeconds } = require("../utils/contestPhase");
const { buildContestResultsUrl } = require("../utils/contestResultsUrl");
const { membershipKeysOr, historicalEnrollmentBatchIdsForStudent } = require("../utils/student-batch-context");

function normSectionId(v) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function normalizeBatchId(v) {
  return String(v || "").trim().toLowerCase();
}

function sectionAllows(student, contest) {
  const ids = Array.isArray(contest.section_ids) ? contest.section_ids.map(normSectionId).filter(Boolean) : [];
  if (ids.length === 0) return true;
  const eff = normSectionId(student?.section_id || student?.enrollment_section || "");
  if (!eff) return false;
  return ids.includes(eff);
}

function batchMatches(student, contest) {
  const cbatch = normalizeBatchId(contest.batch_id);
  if (!cbatch) return false;
  // Read-switch: legacy = [single batch_id] (byte-identical equality); non-legacy = full membership set.
  const studentBatches = membershipKeysOr(student, [normalizeBatchId(student?.batch_id)].filter(Boolean));
  return studentBatches.includes(cbatch);
}

/**
 * True if `contest.batch_id` is one the student has ever belonged to (active OR completed
 * enrollment) but is NOT currently active in. Used only to unlock PAST contests for students
 * who've moved on from a batch — never live/upcoming ones, which stay gated to active membership.
 */
function isLapsedBatchMatch(student, contest, historicalBatchIds) {
  if (batchMatches(student, contest)) return false; // already an active match, not "lapsed"
  const cbatch = normalizeBatchId(contest.batch_id);
  return Boolean(cbatch) && (historicalBatchIds || []).includes(cbatch);
}

function isContestVisibleToStudent(student, contest, now = new Date(), { historicalBatchIds } = {}) {
  if (!contest.is_published) return false;
  const activeMatch = batchMatches(student, contest);
  const lapsedMatch = !activeMatch && isLapsedBatchMatch(student, contest, historicalBatchIds);
  if (!activeMatch && !lapsedMatch) return false;
  if (!sectionAllows(student, contest)) return false;
  const { phase } = getContestPhase(contest, now);
  if (phase === "hidden") return false;
  // A lapsed enrollment only ever surfaces contests that have already ended.
  if (lapsedMatch && phase !== "results") return false;
  return true;
}

function sanitizeUrlsForPhase(contest, phase) {
  const platform_url = phase === "live" ? String(contest.platform_url || "").trim() : "";
  return { platform_url: platform_url || null };
}

function studentResultsUrl(phase, student) {
  if (phase !== "results") return null;
  return buildContestResultsUrl(student?.cst_registration_id);
}

function ctaLabel(cta, phase) {
  if (cta === "join") return "Join contest";
  if (cta === "results") return "View results";
  if (phase === "upcoming") return "Opens soon";
  if (phase === "ended") return "Contest ended";
  return null;
}

function toStudentContestRow(contest, test, now = new Date(), student = null) {
  const { phase, highlight, cta } = getContestPhase(contest, now);
  const urls = sanitizeUrlsForPhase(contest, phase);
  const cstId = String(student?.cst_registration_id || "").trim();
  const has_cst_id = Boolean(cstId);
  const pastContest = phase === "results";
  const te = test || {};
  return {
    id: String(contest._id),
    title: contest.title,
    batch_id: contest.batch_id,
    show_from: contest.show_from,
    start_at: contest.start_at,
    end_at: contest.end_at,
    phase,
    highlight,
    cta: ctaLabel(cta, phase),
    cta_kind: cta,
    countdown_seconds: countdownSeconds(contest, now),
    platform_url: urls.platform_url,
    results_url: studentResultsUrl(phase, student),
    has_cst_id,
    missing_cst: pastContest && !has_cst_id,
    test: te.name
      ? {
          id: String(te._id),
          name: te.name,
          test_type: te.test_type,
          total_marks: te.total_marks,
          exam_date: te.exam_date,
        }
      : null,
  };
}

function toAdminContestRow(contest, test, now = new Date()) {
  const { phase, highlight } = getContestPhase(contest, now);
  const te = test || {};
  return {
    id: String(contest._id),
    title: contest.title,
    test_id: String(contest.test_id),
    batch_id: contest.batch_id,
    section_ids: contest.section_ids || [],
    show_from: contest.show_from,
    start_at: contest.start_at,
    end_at: contest.end_at,
    platform_url: contest.platform_url,
    event_group_id: contest.event_group_id || "",
    is_published: Boolean(contest.is_published),
    published_at: contest.published_at || null,
    phase,
    highlight,
    test: te.name
      ? {
          id: String(te._id),
          name: te.name,
          test_type: te.test_type,
          total_marks: te.total_marks,
          exam_date: te.exam_date,
        }
      : null,
    created_at: contest.createdAt,
    updated_at: contest.updatedAt,
  };
}

async function loadTestsMap(testIds) {
  const ids = [...new Set(testIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await ScorecardTest.find({ _id: { $in: ids } })
    .select("name test_type total_marks exam_date is_active")
    .lean();
  return new Map(rows.map((t) => [String(t._id), t]));
}

async function listContestsForStudent(student, { now = new Date() } = {}) {
  const batchIds = membershipKeysOr(student, [normalizeBatchId(student?.batch_id)].filter(Boolean));
  // An explicit course-switcher pick means "show me only this one" — never widen it back out to
  // the student's other (current or past) batches, even for history.
  const explicit = Boolean(student && student.__membershipExplicit);
  const historicalBatchIds = explicit
    ? []
    : (await historicalEnrollmentBatchIdsForStudent(student?._id)).batchIds;
  const allBatchIds = [...new Set([...batchIds, ...historicalBatchIds])];
  if (!allBatchIds.length) return [];

  const rows = await Contest.find({
    is_published: true,
    batch_id: { $in: allBatchIds },
  })
    .sort({ start_at: -1 })
    .lean();

  const visible = rows.filter((c) => isContestVisibleToStudent(student, c, now, { historicalBatchIds }));
  const tests = await loadTestsMap(visible.map((c) => c.test_id));
  return visible.map((c) => toStudentContestRow(c, tests.get(String(c.test_id)), now, student));
}

async function pickDashboardContestCard(student, now = new Date()) {
  const batchIds = membershipKeysOr(student, [normalizeBatchId(student?.batch_id)].filter(Boolean));
  if (!batchIds.length) return null;

  const rows = await Contest.find({
    is_published: true,
    batch_id: { $in: batchIds },
    show_from: { $lte: now },
    end_at: { $gte: now },
  })
    .sort({ start_at: 1 })
    .lean();

  const match = rows.find((c) => isContestVisibleToStudent(student, c, now));
  if (!match) return null;

  const tests = await loadTestsMap([match.test_id]);
  return toStudentContestRow(match, tests.get(String(match.test_id)), now, student);
}

module.exports = {
  normSectionId,
  normalizeBatchId,
  sectionAllows,
  batchMatches,
  isContestVisibleToStudent,
  toStudentContestRow,
  toAdminContestRow,
  loadTestsMap,
  listContestsForStudent,
  pickDashboardContestCard,
};
