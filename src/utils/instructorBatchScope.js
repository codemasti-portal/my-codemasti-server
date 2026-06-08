const Staff = require("../models/Staff");
const { augmentStudentCatalogFieldsFromEnrollment, catalogBatchIdsFromStudentLean } = require("./enrollment");
const registry = require("./batch-catalog-registry");

/**
 * @returns {null} Caller applies no instructor-only batch restriction.
 * @returns {string[]} Normalized catalog batch_ids (may be empty → instructor sees nothing scoped).
 */
async function getInstructorAssignedBatchIds(req) {
  const role = req.staff?.role;
  if (role !== "instructor" && role !== "mentor") return null;
  if (!req.staff?.sub) return role === "instructor" ? [] : null;
  const doc = await Staff.findById(req.staff.sub).select("batches_assigned").lean();
  if (!doc) return role === "instructor" ? [] : null;
  const ids = [
    ...new Set(
      (doc.batches_assigned || []).map((id) => String(id || "").trim().toLowerCase()).filter(Boolean)
    ),
  ];
  /** Mentors without program assignments are not batch-scoped (e.g. doubt community filters). */
  if (role === "mentor" && !ids.length) return null;
  return ids;
}

function studentInAnyAssignedBatch(studentDoc, allowedNormalizedBatchIds) {
  if (!allowedNormalizedBatchIds?.length) return false;
  const aug = augmentStudentCatalogFieldsFromEnrollment(studentDoc);
  const ids = catalogBatchIdsFromStudentLean(aug);
  const allow = new Set(allowedNormalizedBatchIds);
  return ids.some((id) => allow.has(String(id || "").trim().toLowerCase()));
}

/**
 * M:N-aware variant: an instructor may access a student if the student has an ACTIVE enrollment in any
 * of the instructor's assigned batches — not just their legacy primary batch. Keeps `getStudent` /
 * scorecard access consistent with the M:N-scoped student LIST. Legacy mode is byte-identical.
 */
async function studentInAnyAssignedBatchResolved(studentDoc, allowedNormalizedBatchIds) {
  if (!allowedNormalizedBatchIds?.length || !studentDoc?._id) return false;
  const StudentEnrollment = require("../models/StudentEnrollment");
  const allow = [...new Set(allowedNormalizedBatchIds.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
  if (!allow.length) return false;
  const hit = await StudentEnrollment.findOne({
    student_id: studentDoc._id,
    status: "active",
    batch_id: { $in: allow },
  })
    .select("_id")
    .lean();
  return Boolean(hit);
}

function assignmentDocTouchesAllowedBatches(doc, allowed) {
  if (!allowed?.length) return false;
  const set = new Set(allowed.map((x) => String(x || "").trim().toLowerCase()));
  const ids = [];
  if (doc.batch_id) ids.push(String(doc.batch_id).trim().toLowerCase());
  for (const x of doc.batch_ids || []) ids.push(String(x).trim().toLowerCase());
  return ids.some((id) => id && set.has(id));
}

function arenaDocTouchesAllowedBatches(doc, allowed) {
  if (!allowed?.length) return false;
  const set = new Set(allowed.map((x) => String(x || "").trim().toLowerCase()));
  const bid = String(doc.batch_id || "").trim().toLowerCase();
  if (bid && set.has(bid)) return true;
  for (const x of doc.batch_ids || []) {
    if (set.has(String(x || "").trim().toLowerCase())) return true;
  }
  return false;
}

/** Mongo filter: announcements visible to an instructor with these assigned catalog ids */
function announcementFilterForInstructorBatches(allowed) {
  if (!allowed.length) return { _id: null };
  const batchNameOr = allowed
    .map((bid) => registry.displayNameSync(bid))
    .filter(Boolean)
    .map((name) => ({ scope: "batch", batch: name, $or: [{ batch_id: "" }, { batch_id: { $exists: false } }] }));

  return {
    $or: [{ scope: "global" }, { scope: "batch", batch_id: { $in: allowed } }, ...batchNameOr],
  };
}

/** Mongo filter: staff notes (study material) visible to instructor */
function noteVisibleToInstructorFilter(allowed) {
  if (!allowed.length) return { _id: null };
  return {
    $or: [
      { target_batch_ids: { $in: allowed } },
      { "target_section_refs.batch_id": { $in: allowed } },
      {
        $and: [
          { $or: [{ target_batch_ids: { $exists: false } }, { target_batch_ids: { $size: 0 } }] },
          { $or: [{ target_section_refs: { $exists: false } }, { target_section_refs: { $size: 0 } }] },
        ],
      },
    ],
  };
}

function announcementVisibleToInstructor(doc, allowed) {
  if (!allowed?.length) return false;
  if (doc.scope === "global") return true;
  return announcementIsBatchScopedToAllowed(doc, allowed);
}

/** Batch-scoped announcement targets a program the instructor is assigned to (not global). */
function announcementIsBatchScopedToAllowed(doc, allowed) {
  if (!allowed?.length || !doc) return false;
  const bid = String(doc.batch_id || "").trim().toLowerCase();
  if (bid && allowed.includes(bid)) return true;
  const label = String(doc.batch || "").trim();
  for (const id of allowed) {
    const nm = registry.displayNameSync(id);
    if (nm && nm === label) return true;
  }
  return false;
}

function noteMatchesInstructorScope(doc, allowed) {
  if (!allowed?.length) return false;
  const targets = (doc.target_batch_ids || []).map((x) => String(x || "").trim().toLowerCase());
  const refs = doc.target_section_refs || [];
  if (targets.some((t) => allowed.includes(t))) return true;
  if (refs.some((r) => allowed.includes(String(r.batch_id || "").trim().toLowerCase()))) return true;
  if (!targets.length && !refs.length) return true;
  return false;
}

module.exports = {
  getInstructorAssignedBatchIds,
  studentInAnyAssignedBatch,
  studentInAnyAssignedBatchResolved,
  assignmentDocTouchesAllowedBatches,
  arenaDocTouchesAllowedBatches,
  announcementFilterForInstructorBatches,
  noteVisibleToInstructorFilter,
  announcementVisibleToInstructor,
  announcementIsBatchScopedToAllowed,
  noteMatchesInstructorScope,
};
