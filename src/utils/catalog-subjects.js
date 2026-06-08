/**
 * Catalog subjects — the SINGLE source of truth for "what subjects a batch has".
 *
 * Subjects are defined per batch in admin (Batches) and stored on BatchCatalog.sections[].subjects.
 * Every subject *list* shown to students (assignments/arena/notes/lectures/doubts filters) and every
 * subject *write* (create/update of assignments, arena questions, timetable, live classes, mentor
 * slots, notes) must go through this helper, so a subject can only ever be one the admin defined.
 *
 * Reads are direct + lean (these are list/validation paths, not hot loops). Casing is canonicalised
 * to whatever the catalog stores (first occurrence wins), so "maths"/"Maths" can't drift.
 * No DB writes here; the model is required lazily so importing never opens a connection.
 */

const norm = (s) => String(s || "").trim().toLowerCase();

/** Subjects for ONE batch, deduped (case-insensitive) + sorted, in the catalog's canonical casing. */
async function catalogSubjects(batchId) {
  const bid = norm(batchId);
  if (!bid) return [];
  const BatchCatalog = require("../models/BatchCatalog");
  const cat = await BatchCatalog.findOne({ batch_id: bid }).select("sections").lean();
  const byLower = new Map(); // lower -> canonical (first seen wins)
  for (const sec of cat?.sections || []) {
    for (const s of sec?.subjects || []) {
      const v = String(s || "").trim();
      if (v && !byLower.has(v.toLowerCase())) byLower.set(v.toLowerCase(), v);
    }
  }
  return [...byLower.values()].sort((a, b) => a.localeCompare(b));
}

/** Union of subjects across several batches (multi-batch content), deduped + sorted. */
async function catalogSubjectsForBatches(batchIds) {
  const ids = [...new Set((Array.isArray(batchIds) ? batchIds : [batchIds]).map(norm).filter(Boolean))];
  if (!ids.length) return [];
  if (ids.length === 1) return catalogSubjects(ids[0]);
  const lists = await Promise.all(ids.map((id) => catalogSubjects(id)));
  const byLower = new Map();
  for (const list of lists) {
    for (const s of list) if (!byLower.has(s.toLowerCase())) byLower.set(s.toLowerCase(), s);
  }
  return [...byLower.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * If `subject` matches a catalog subject of the given batch(es) (case-insensitively), return the
 * canonical casing; otherwise null. Use for create/update validation:
 *   const canon = await canonicalSubjectForBatches(batchIds, body.subject);
 *   if (body.subject && !canon) return sendError(... list catalogSubjectsForBatches ...);
 *   if (canon) body.subject = canon; // store canonical casing
 */
async function canonicalSubjectForBatches(batchIds, subject) {
  const want = norm(subject);
  if (!want) return null;
  const subs = await catalogSubjectsForBatches(batchIds);
  return subs.find((s) => s.toLowerCase() === want) || null;
}

/**
 * Validate a subject for create/update handlers. Returns:
 *   { ok: true, value }          — valid (value = canonical casing), OR no subject provided (untagged)
 *   { ok: false, allowed: [...] } — provided but not in the batch(es) catalog (caller sends a 400)
 */
async function validateBatchSubject(batchIds, subject) {
  if (subject === undefined || subject === null || String(subject).trim() === "") {
    return { ok: true, value: subject };
  }
  const canon = await canonicalSubjectForBatches(batchIds, subject);
  if (canon) return { ok: true, value: canon };
  return { ok: false, allowed: await catalogSubjectsForBatches(batchIds) };
}

/** Standard 400 message body for an invalid subject, given the allowed catalog list. */
function invalidSubjectMessage(allowed) {
  return allowed && allowed.length
    ? `Subject must be one of this batch's subjects: ${allowed.join(", ")}.`
    : "This batch has no subjects defined yet. Add subjects to the batch first.";
}

module.exports = {
  catalogSubjects,
  catalogSubjectsForBatches,
  canonicalSubjectForBatches,
  validateBatchSubject,
  invalidSubjectMessage,
};
