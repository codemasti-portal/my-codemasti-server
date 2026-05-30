const Contest = require("../models/Contest");
const ScorecardTest = require("../models/ScorecardTest");
const { getContestPhase, countdownSeconds } = require("../utils/contestPhase");

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
  const sbatch = normalizeBatchId(student?.batch_id);
  const cbatch = normalizeBatchId(contest.batch_id);
  if (!cbatch) return false;
  if (!sbatch) return false;
  return sbatch === cbatch;
}

function isContestVisibleToStudent(student, contest, now = new Date()) {
  if (!contest.is_published) return false;
  if (!batchMatches(student, contest)) return false;
  if (!sectionAllows(student, contest)) return false;
  const { phase } = getContestPhase(contest, now);
  return phase !== "hidden";
}

function sanitizeUrlsForPhase(contest, phase) {
  const platform_url = phase === "live" ? String(contest.platform_url || "").trim() : "";
  const results_url =
    phase === "results" || phase === "ended" ? String(contest.results_url || "").trim() : "";
  return { platform_url: platform_url || null, results_url: results_url || null };
}

function ctaLabel(cta, phase) {
  if (cta === "join") return "Join contest";
  if (cta === "results") return "View results";
  if (phase === "upcoming") return "Opens soon";
  if (phase === "ended") return "Contest ended";
  return null;
}

function toStudentContestRow(contest, test, now = new Date()) {
  const { phase, highlight, cta } = getContestPhase(contest, now);
  const urls = sanitizeUrlsForPhase(contest, phase);
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
    results_url: urls.results_url,
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
    results_url: contest.results_url || "",
    results_until: contest.results_until || null,
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

async function listContestsForStudent(student, { now = new Date(), includeEndedDays = 30 } = {}) {
  const batchId = normalizeBatchId(student?.batch_id);
  if (!batchId) return [];

  const cutoff = new Date(now.getTime() - includeEndedDays * 24 * 60 * 60 * 1000);
  const rows = await Contest.find({
    is_published: true,
    batch_id: batchId,
    end_at: { $gte: cutoff },
  })
    .sort({ start_at: -1 })
    .lean();

  const visible = rows.filter((c) => isContestVisibleToStudent(student, c, now));
  const tests = await loadTestsMap(visible.map((c) => c.test_id));
  return visible.map((c) => toStudentContestRow(c, tests.get(String(c.test_id)), now));
}

async function pickDashboardContestCard(student, now = new Date()) {
  const batchId = normalizeBatchId(student?.batch_id);
  if (!batchId) return null;

  const rows = await Contest.find({
    is_published: true,
    batch_id: batchId,
    show_from: { $lte: now },
    end_at: { $gte: now },
  })
    .sort({ start_at: 1 })
    .lean();

  const match = rows.find((c) => isContestVisibleToStudent(student, c, now));
  if (!match) return null;

  const tests = await loadTestsMap([match.test_id]);
  return toStudentContestRow(match, tests.get(String(match.test_id)), now);
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
