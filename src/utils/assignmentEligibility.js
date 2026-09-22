/**
 * Shared student eligibility for assignments.
 *
 * Non-Project types (quiz, coding, written, web, other): released + active batch
 * membership. section_id / section_ids are not an authorization boundary for these
 * types — that matches pre-Project list/detail/run/submit behavior. A non-empty
 * legacy section_id may still narrow release notifications, which can leave
 * cross-section students able to open the assignment without receiving the notify.
 *
 * Project types: released + active batch enrollment + per-batch section targeting
 * (empty section_ids = all sections in that batch). Publication/document readiness
 * is applied separately via projectPublication helpers.
 */

const { membershipKeysOr } = require("./student-batch-context");
const { effectiveAssignmentSectionIds, normSectionId, normBatchId } = require("./assignmentSectionTargeting");
const { isProjectAssignmentType } = require("./projectQuestionPolicy");

function isAssignmentReleased(assignment, now = new Date()) {
  const t = new Date(assignment?.release_date).getTime();
  return !Number.isNaN(t) && t <= now.getTime();
}

/** Normalized catalog batch keys on an assignment (batch_id + batch_ids), deduped. */
function assignmentScopeBatchKeys(assignment) {
  const keys = [];
  const a = assignment || {};
  const primary = normBatchId(a.batch_id);
  if (primary) keys.push(primary);
  const arr = Array.isArray(a.batch_ids) ? a.batch_ids : [];
  for (const x of arr) {
    const z = normBatchId(x);
    if (z) keys.push(z);
  }
  return [...new Set(keys)];
}

/**
 * Section the student occupies in a catalog batch.
 * Prefers enrollment map attached by scopeStudentToBatch; falls back to primary Student.section_id
 * only when that batch is the student's primary batch_id.
 */
function studentSectionForBatch(student, batchId) {
  const bid = normBatchId(batchId);
  if (!bid || !student) return "";
  const map = student.__membershipSectionByBatch;
  if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, bid)) {
    return normSectionId(map[bid]);
  }
  const primary = normBatchId(student.batch_id);
  if (primary === bid) {
    const fromCatalog = normSectionId(student.section_id);
    if (fromCatalog) return fromCatalog;
    return normSectionId(student.enrollment_section);
  }
  return "";
}

function studentBatchesForEligibility(student) {
  return membershipKeysOr(student, [normBatchId(student?.batch_id)].filter(Boolean));
}

/**
 * Batch membership only (no section targeting). Used for non-Project assignment types.
 */
function studentMeetsAssignmentBatch(assignment, student) {
  const scopes = assignmentScopeBatchKeys(assignment);
  if (scopes.length === 0) return true;

  const studentBatches = studentBatchesForEligibility(student);
  if (studentBatches.length === 0) return false;

  return scopes.some((b) => studentBatches.includes(b));
}

/**
 * Batch + section targeting without release_date (Project authorization).
 */
function studentMeetsAssignmentBatchSection(assignment, student) {
  if (!studentMeetsAssignmentBatch(assignment, student)) return false;

  const scopes = assignmentScopeBatchKeys(assignment);
  if (scopes.length === 0) return true;

  const studentBatches = studentBatchesForEligibility(student);
  const overlap = scopes.filter((b) => studentBatches.includes(b));
  const targetSections = effectiveAssignmentSectionIds(assignment);
  if (!targetSections.length) return true;

  return overlap.some((bid) => {
    const sid = studentSectionForBatch(student, bid);
    return Boolean(sid) && targetSections.includes(sid);
  });
}

/**
 * Released + type-specific targeting.
 * Does not apply Project draft/publish — callers must also use projectPublication helpers.
 * Legacy unscoped assignments (no batch_id / batch_ids) remain visible to any enrolled student
 * once released — they have no section dimension to enforce.
 */
function isAssignmentVisibleToStudent(assignment, student, now = new Date()) {
  if (!isAssignmentReleased(assignment, now)) return false;
  if (isProjectAssignmentType(assignment?.assignment_type)) {
    return studentMeetsAssignmentBatchSection(assignment, student);
  }
  return studentMeetsAssignmentBatch(assignment, student);
}

module.exports = {
  isAssignmentReleased,
  assignmentScopeBatchKeys,
  studentSectionForBatch,
  studentBatchesForEligibility,
  studentMeetsAssignmentBatch,
  studentMeetsAssignmentBatchSection,
  isAssignmentVisibleToStudent,
};
