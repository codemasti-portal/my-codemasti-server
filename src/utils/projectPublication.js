/**
 * Project-only publication lifecycle.
 * Non-project assignment types ignore these helpers.
 *
 * States:
 *   draft     — staff may author; students cannot discover/submit; no release notifications
 *   published — students may see it only when release_date has also passed
 *
 * Legacy: historical Project rows may omit `project_published`.
 * They stay student-visible only when they already have a complete canonical document
 * (same instructional checks as publish). Incomplete legacy rows are treated as draft
 * for student access and must not become visible merely because the field is missing.
 */

const AssignmentQuestion = require("../models/AssignmentQuestion");
const BatchCatalog = require("../models/BatchCatalog");
const { isProjectAssignmentType } = require("./projectQuestionPolicy");
const { hasProjectDocumentContent, normalizeProjectDocument } = require("./projectDocument");
const {
  effectiveAssignmentSectionIds,
  validateSectionsForCatalog,
  normBatchId,
} = require("./assignmentSectionTargeting");
const { normalizeProjectMaxMarks } = require("../services/project-submission.service");
const { fullQuestionXp } = require("./assignmentXp");

function projectPublicationStatus(assignment) {
  if (!isProjectAssignmentType(assignment?.assignment_type)) return "n/a";
  if (assignment.project_published === true) return "published";
  if (assignment.project_published === false) return "draft";
  return "legacy";
}

function isExplicitProjectDraft(assignment) {
  return isProjectAssignmentType(assignment?.assignment_type) && assignment.project_published === false;
}

function mongoExcludeExplicitProjectDrafts() {
  return { $nor: [{ assignment_type: "project", project_published: false }] };
}

function isProjectDocumentPublishable(doc) {
  const n = normalizeProjectDocument(doc || {});
  if (!n.ok) return { ok: false, message: n.message };
  const value = n.value;
  if (!String(value.overview || "").trim()) {
    return { ok: false, message: "Add a project overview before publishing." };
  }
  if (!String(value.deliverables || "").trim()) {
    return { ok: false, message: "Add expected deliverables before publishing." };
  }
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (!steps.length) {
    return { ok: false, message: "Add at least one implementation step before publishing." };
  }
  const usable = steps.find((s) => String(s.title || "").trim() && String(s.content || "").trim());
  if (!usable) {
    return { ok: false, message: "Each published project needs at least one step with a title and instructions." };
  }
  if (!hasProjectDocumentContent(value)) {
    return { ok: false, message: "The project document is empty." };
  }
  return { ok: true, value };
}

function validateProjectReadiness({ assignment, questions, catalogDoc } = {}) {
  if (!isProjectAssignmentType(assignment?.assignment_type)) {
    return { ok: false, code: "NOT_A_PROJECT", message: "Only Project assignments use this publication lifecycle." };
  }
  const qs = Array.isArray(questions) ? questions : [];
  const details = [];
  if (!qs.length) {
    return {
      ok: false,
      code: "PROJECT_NOT_READY",
      message: "This project has no document question yet.",
      details: ["Create the project document before publishing."],
    };
  }
  if (qs.length > 1) {
    return {
      ok: false,
      code: "PROJECT_AMBIGUOUS",
      message: "This project has multiple questions and cannot be published until it has a single document.",
      details: [`Found ${qs.length} questions.`],
    };
  }
  const question = qs[0];
  const docCheck = isProjectDocumentPublishable(question.project_document);
  if (!docCheck.ok) details.push(docCheck.message);
  const xp = fullQuestionXp(question.xp);
  if (!Number.isFinite(xp) || xp < 0) details.push("XP must be a non-negative integer.");
  const maxMarks = normalizeProjectMaxMarks(assignment.project_max_marks, 0);
  if (!(maxMarks > 0)) details.push("Maximum marks must be greater than 0.");
  const batchId = normBatchId(assignment.batch_id);
  if (!batchId) details.push("The project must be targeted to a batch.");
  const sectionIds = effectiveAssignmentSectionIds(assignment);
  if (sectionIds.length && catalogDoc) {
    const check = validateSectionsForCatalog(batchId, sectionIds, catalogDoc);
    if (!check.ok) details.push(check.message);
  } else if (sectionIds.length && !catalogDoc) {
    details.push("Section targeting could not be verified against the batch catalog.");
  }
  if (details.length) {
    return { ok: false, code: "PROJECT_NOT_READY", message: details[0], details };
  }
  return { ok: true };
}

async function loadProjectQuestions(assignmentId) {
  return AssignmentQuestion.find({ assignment_id: assignmentId }).sort({ createdAt: 1 }).lean();
}

async function assessProjectReadiness(assignment) {
  if (!isProjectAssignmentType(assignment?.assignment_type)) {
    return { ok: true, status: "n/a" };
  }
  const questions = await loadProjectQuestions(assignment._id || assignment.id);
  let catalogDoc = null;
  const batchId = normBatchId(assignment.batch_id);
  const sectionIds = effectiveAssignmentSectionIds(assignment);
  if (batchId && sectionIds.length) {
    catalogDoc = await BatchCatalog.findOne({ batch_id: batchId }).select("batch_id sections").lean();
  }
  const result = validateProjectReadiness({ assignment, questions, catalogDoc });
  return { ...result, questions, status: projectPublicationStatus(assignment) };
}

function assignmentHasPublishableDocument(assignment, questions) {
  const qs = Array.isArray(questions) ? questions : [];
  if (qs.length !== 1) return false;
  if (!isProjectDocumentPublishable(qs[0].project_document).ok) return false;
  const maxMarks = Number(assignment?.project_max_marks);
  return Number.isFinite(maxMarks) && maxMarks > 0;
}

/**
 * Whether students may newly discover / open / submit this Project.
 * Non-projects return true (caller still applies release_date + batch/section).
 */
async function isProjectOpenForStudentDiscovery(assignment, questionsMaybe) {
  if (!isProjectAssignmentType(assignment?.assignment_type)) return true;
  if (assignment.project_published === false) return false;
  const questions =
    questionsMaybe || (await AssignmentQuestion.find({ assignment_id: assignment._id }).sort({ createdAt: 1 }).lean());
  return assignmentHasPublishableDocument(assignment, questions);
}

async function filterAssignmentsOpenToStudents(assignments) {
  const list = Array.isArray(assignments) ? assignments : [];
  const projects = list.filter((a) => isProjectAssignmentType(a.assignment_type) && a.project_published !== false);
  if (!projects.length) return list.filter((a) => !isExplicitProjectDraft(a));
  const questions = await AssignmentQuestion.find({ assignment_id: { $in: projects.map((a) => a._id) } })
    .sort({ createdAt: 1 })
    .lean();
  const byAssignment = new Map();
  for (const q of questions) {
    const key = String(q.assignment_id);
    if (!byAssignment.has(key)) byAssignment.set(key, []);
    byAssignment.get(key).push(q);
  }
  return list.filter((a) => {
    if (!isProjectAssignmentType(a.assignment_type)) return true;
    if (a.project_published === false) return false;
    return assignmentHasPublishableDocument(a, byAssignment.get(String(a._id)) || []);
  });
}

/**
 * Published Projects must keep a complete document. Drafts may be incomplete.
 * Returns an error descriptor, or null when the update is allowed.
 */
function publishedProjectDocumentUpdateError(assignment, proposedDocument) {
  if (!isProjectAssignmentType(assignment?.assignment_type)) return null;
  if (assignment.project_published !== true) return null;
  if (proposedDocument === undefined) return null;
  const check = isProjectDocumentPublishable(proposedDocument);
  if (check.ok) return null;
  return {
    code: "PROJECT_PUBLISHED_DOCUMENT_INCOMPLETE",
    message: `${check.message} Unpublish the project before saving an incomplete document.`,
  };
}

module.exports = {
  projectPublicationStatus,
  isExplicitProjectDraft,
  mongoExcludeExplicitProjectDrafts,
  isProjectDocumentPublishable,
  validateProjectReadiness,
  loadProjectQuestions,
  assessProjectReadiness,
  assignmentHasPublishableDocument,
  isProjectOpenForStudentDiscovery,
  filterAssignmentsOpenToStudents,
  publishedProjectDocumentUpdateError,
};
