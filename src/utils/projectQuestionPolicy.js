const { effectiveAssignmentSectionIds, uniqueSectionIds } = require("./assignmentSectionTargeting");

const CANONICAL_PROJECT_SLOT = "canonical";

function isProjectAssignmentType(type) {
  return String(type || "").toLowerCase() === "project";
}

function isCanonicalProjectSlot(value) {
  return String(value || "").trim() === CANONICAL_PROJECT_SLOT;
}

/** Placeholder / bulk create on assignment POST. */
function mayCreateProjectQuestionPlaceholders(assignmentType, questionCount) {
  if (!isProjectAssignmentType(assignmentType)) return { ok: true };
  if (Number(questionCount || 0) > 1) {
    return {
      ok: false,
      code: "PROJECT_QUESTION_LIMIT",
      message: "Project assignments support a single document question. Omit question_count or set it to 0 or 1.",
    };
  }
  return { ok: true };
}

/** POST /admin/assignments/:id/questions */
function mayCreateProjectQuestion(assignmentType, existingQuestionCount) {
  if (!isProjectAssignmentType(assignmentType)) return { ok: true };
  if (Number(existingQuestionCount || 0) >= 1) {
    return {
      ok: false,
      code: "PROJECT_QUESTION_EXISTS",
      message: "This project already has a document question. Edit the existing question instead of creating another.",
    };
  }
  return { ok: true };
}

function sameInstant(a, b) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && ta === tb;
}

/**
 * Shared identity for one Project creation_group_id operation (not per-batch targeting).
 */
function projectCreationSharedMetadataMatches(existing, fields) {
  if (!existing || !fields) return false;
  if (String(existing.assignment_type || "").toLowerCase() !== "project") return false;
  if (String(existing.title || "").trim() !== String(fields.title || "").trim()) return false;
  if (String(existing.subject || "").trim() !== String(fields.subject || "").trim()) return false;
  if (String(existing.module || "").trim() !== String(fields.module || "").trim()) return false;
  if (!sameInstant(existing.release_date, fields.release_date)) return false;
  if (!sameInstant(existing.deadline_date, fields.deadline_date)) return false;
  return Number(existing.project_max_marks) === Number(fields.project_max_marks);
}

function projectCreationSectionMatches(existing, sectionIds) {
  const have = effectiveAssignmentSectionIds(existing).slice().sort().join("\n");
  const want = uniqueSectionIds(sectionIds).slice().sort().join("\n");
  return have === want;
}

function projectCreationPayloadMatches(existing, fields) {
  return (
    projectCreationSharedMetadataMatches(existing, fields) &&
    projectCreationSectionMatches(existing, fields.section_ids)
  );
}

module.exports = {
  CANONICAL_PROJECT_SLOT,
  isProjectAssignmentType,
  isCanonicalProjectSlot,
  mayCreateProjectQuestionPlaceholders,
  mayCreateProjectQuestion,
  projectCreationSharedMetadataMatches,
  projectCreationSectionMatches,
  projectCreationPayloadMatches,
};
