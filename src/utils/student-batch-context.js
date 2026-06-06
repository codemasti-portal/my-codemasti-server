/**
 * Student "current course" context resolution.
 *
 * Background: a student may be enrolled in multiple Courses (e.g. Spark + a workshop).
 * The portal lets them switch between them via a course-picker. The picked course is
 * sent back to the server as `?batch_id=<linked_batch_id>`.
 *
 * Two public helpers:
 *   - resolveStudentBatchContext(req, student) → { batchId, batchIds, explicit }
 *     Pure: never mutates `student`. Use when you only need batch ids.
 *   - scopeStudentToBatch(req, student) → resolved context
 *     Convenience: when `explicit`, MUTATES the lean `student` object so existing
 *     helpers (`catalogBatchIdsFromStudentLean`, `studentClassVisibilityFilter`, etc.)
 *     that read `student.batch_id` / `student.enrollment_number` Just Work without
 *     touching their signatures. Safe because `student` is a `.lean()` doc — never saved.
 *
 * Backward compatible: if the client doesn't send batch_id, both helpers return today's behavior.
 * Safe: validation prevents `?batch_id=foo` from peeking at batches the student isn't in.
 */

const StudentEnrollment = require("../models/StudentEnrollment");
const Course = require("../models/Course");
const {
  catalogBatchIdsFromStudentLean,
  catalogBatchMongoMatch,
  studentsInCatalogBatchesFilter,
  catalogBatchStudentFilter,
} = require("./enrollment");

/**
 * Membership read source (read-switch flag). Controls the future resolver below.
 *   "legacy"     — derive batch ids from Student.batch_id / enrollment_number (today's behavior; default)
 *   "union"      — legacy ∪ enrollment-derived (fail-safe: never drops a student during the switch)
 *   "enrollment" — StudentEnrollment is authoritative (the end state)
 */
function membershipMode() {
  const v = String(process.env.BATCH_MEMBERSHIP_SOURCE || "legacy").toLowerCase().trim();
  return ["legacy", "union", "enrollment"].includes(v) ? v : "legacy";
}

/**
 * Active batch ids for a student from their enrollments. Uses the denormalized
 * StudentEnrollment.batch_id, falling back to Course.linked_batch_id for any not-yet-stamped rows.
 */
async function enrollmentBatchIdsForStudent(studentId) {
  if (!studentId) return { batchIds: [], sectionByBatch: {} };
  const rows = await StudentEnrollment.find({ student_id: studentId, status: "active" })
    .select("batch_id section_id course_id")
    .lean();
  const ids = new Set();
  const sectionByBatch = {};
  const needCourse = [];
  for (const r of rows) {
    const bid = String(r.batch_id || "").toLowerCase().trim();
    if (bid) {
      ids.add(bid);
      if (r.section_id && !sectionByBatch[bid]) sectionByBatch[bid] = String(r.section_id).toLowerCase().trim();
    } else if (r.course_id) {
      needCourse.push(r);
    }
  }
  if (needCourse.length) {
    const courseIds = [...new Set(needCourse.map((r) => String(r.course_id)))];
    const courses = await Course.find({ _id: { $in: courseIds } }).select("linked_batch_id").lean();
    const byId = new Map(courses.map((c) => [String(c._id), String(c.linked_batch_id || "").toLowerCase().trim()]));
    for (const r of needCourse) {
      const bid = byId.get(String(r.course_id));
      if (!bid) continue;
      ids.add(bid);
      if (r.section_id && !sectionByBatch[bid]) sectionByBatch[bid] = String(r.section_id).toLowerCase().trim();
    }
  }
  return { batchIds: [...ids], sectionByBatch };
}

/**
 * Future authoritative membership resolver (enrollment-backed), flag-gated. ADDITIVE — not yet
 * wired into live read paths (that's the read-switch step). Returns the legacy shape plus diagnostics.
 * @param {object|string} studentOrId  a lean Student doc (preferred) or a student id
 */
async function resolveStudentBatchIds(studentOrId, { mode } = {}) {
  const m = mode || membershipMode();
  let studentDoc = null;
  let studentId = null;
  if (studentOrId && typeof studentOrId === "object") {
    studentDoc = studentOrId;
    studentId = studentOrId._id;
  } else {
    studentId = studentOrId;
  }

  let legacySet = [];
  if (m !== "enrollment") {
    if (!studentDoc && studentId) {
      const Student = require("../models/Student");
      studentDoc = await Student.findById(studentId).select("batch_id enrollment_number").lean();
    }
    // Compute legacy from RAW fields only — never read an attached membership set (avoids recursion).
    legacySet = catalogBatchIdsFromStudentLean({
      batch_id: studentDoc?.batch_id,
      enrollment_number: studentDoc?.enrollment_number,
    });
  }

  let enrollmentSet = [];
  let sectionByBatch = {};
  if (m !== "legacy") {
    const r = await enrollmentBatchIdsForStudent(studentId);
    enrollmentSet = r.batchIds;
    sectionByBatch = r.sectionByBatch;
  }

  let batchIds;
  if (m === "legacy") batchIds = legacySet;
  else if (m === "enrollment") batchIds = enrollmentSet;
  else batchIds = [...new Set([...legacySet, ...enrollmentSet])]; // union (fail-safe)

  return { batchIds, sectionByBatch, legacySet, enrollmentSet, mode: m };
}

async function resolveStudentBatchContext(req, student) {
  const requested = String(req?.query?.batch_id || "").trim().toLowerCase();

  if (requested && student?._id) {
    // Is the student ACTIVELY enrolled in the requested batch? Check the denormalized batch_id
    // (M:N source of truth) directly — the old code grabbed one arbitrary active enrollment and
    // only matched THAT one, so a secondary batch (primary elsewhere) never validated. Fall back to
    // the course link in case an enrollment is missing the denormalized batch_id.
    let enrolled = await StudentEnrollment.findOne({
      student_id: student._id,
      status: "active",
      batch_id: requested,
    })
      .select("_id")
      .lean();
    if (!enrolled) {
      const courses = await Course.find({ linked_batch_id: requested }).select("_id").lean();
      if (courses.length) {
        enrolled = await StudentEnrollment.findOne({
          student_id: student._id,
          status: "active",
          course_id: { $in: courses.map((c) => c._id) },
        })
          .select("_id")
          .lean();
      }
    }
    if (enrolled) {
      return { batchId: requested, batchIds: [requested], explicit: true };
    }
    // Not enrolled in the requested batch — ignore it and fall through.
  }

  const fallback = String(student?.batch_id || "").trim().toLowerCase();
  const mode = membershipMode();
  let batchIds;
  if (mode === "legacy") {
    batchIds = catalogBatchIdsFromStudentLean(student); // unchanged legacy behavior
  } else {
    batchIds = (await resolveStudentBatchIds(student, { mode })).batchIds;
  }
  return { batchId: fallback, batchIds, explicit: false };
}

/**
 * Resolves AND, when an explicit pick is present, overrides student.batch_id +
 * clears enrollment_number on the in-memory student doc so downstream helpers
 * naturally scope to the chosen batch.
 */
async function scopeStudentToBatch(req, student) {
  const ctx = await resolveStudentBatchContext(req, student);
  if (ctx.explicit && student) {
    student.batch_id = ctx.batchId;
    // Suppress the enrollment-derived batch path — caller explicitly picked one.
    student.enrollment_number = "";
  }
  // Read-switch: attach the resolved membership set so the sync chokepoint
  // (catalogBatchIdsFromStudentLean) returns it. No-op under legacy mode (nothing attached).
  if (student && membershipMode() !== "legacy") {
    student.__membershipBatchIds = ctx.batchIds;
  }
  return ctx;
}

// ---- Cohort resolution ("which students are in batch X") for the read-switch ----
// Each *Resolved wrapper returns the EXACT legacy filter in legacy mode (a perfect no-op),
// and an enrollment-derived student-id set otherwise. "union" mode never drops a student the
// legacy filter would have matched (RISK-2 fail-safe).

// The Mongo connection runs with serverApi.strict:true, which bans the `distinct` command.
// Dedupe student ids in application code instead (returns ObjectIds, like .distinct() did).
async function distinctStudentIdsForQuery(q) {
  const rows = await StudentEnrollment.find(q).select("student_id").lean();
  const byId = new Map();
  for (const r of rows) byId.set(String(r.student_id), r.student_id);
  return [...byId.values()];
}

/** Distinct active-enrollment student ids for the given batch(es), with optional section filter. */
async function studentIdsInBatches(batchKeys, { sectionId = "", sectionIds } = {}) {
  const keys = [...new Set((batchKeys || []).map((k) => String(k || "").toLowerCase().trim()).filter(Boolean))];
  if (!keys.length) return [];
  const q = { batch_id: { $in: keys }, status: "active" };
  const sids = Array.isArray(sectionIds)
    ? sectionIds.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean)
    : sectionId
      ? [String(sectionId).toLowerCase().trim()]
      : [];
  if (sids.length === 1) q.section_id = sids[0];
  else if (sids.length > 1) q.section_id = { $in: sids };
  return distinctStudentIdsForQuery(q);
}

/** Union of an enrollment-derived id set with whoever the legacy Student filter matches. */
async function unionWithLegacy(legacyFilter, enrollmentIds) {
  const Student = require("../models/Student");
  const legacyRows = await Student.find(legacyFilter).select("_id").lean();
  const merged = new Map(enrollmentIds.map((x) => [String(x), x]));
  for (const r of legacyRows) merged.set(String(r._id), r._id);
  return [...merged.values()];
}

/** Spreadable Student.find partial for one batch (mirrors catalogBatchMongoMatch). */
async function catalogBatchMongoMatchResolved(batchId) {
  const mode = membershipMode();
  if (mode === "legacy") return catalogBatchMongoMatch(batchId);
  const ids = await studentIdsInBatches([batchId]);
  if (mode === "enrollment") return { _id: { $in: ids } };
  const unionIds = await unionWithLegacy({ role: "student", ...catalogBatchMongoMatch(batchId) }, ids);
  return { _id: { $in: unionIds } };
}

/** Full Student.find filter for a set of batches + section (mirrors studentsInCatalogBatchesFilter). */
async function studentsInBatchesFilterResolved(batchKeys, opts = {}) {
  const mode = membershipMode();
  if (mode === "legacy") return studentsInCatalogBatchesFilter(batchKeys, opts);
  const ids = await studentIdsInBatches(batchKeys, opts);
  if (mode === "enrollment") return { role: "student", _id: { $in: ids } };
  const unionIds = await unionWithLegacy(studentsInCatalogBatchesFilter(batchKeys, opts), ids);
  return { role: "student", _id: { $in: unionIds } };
}

/** Full Student.find filter for one batch + raw section (mirrors catalogBatchStudentFilter). */
async function catalogBatchStudentFilterResolved(batchId, rawSection) {
  const mode = membershipMode();
  if (mode === "legacy") return catalogBatchStudentFilter(batchId, rawSection);
  const bid = String(batchId || "").toLowerCase().trim();
  const hasSection = rawSection !== undefined && String(rawSection).trim() !== "";
  const sid = hasSection ? String(rawSection).trim().toLowerCase().replace(/\s+/g, "-") : "";
  const q = { batch_id: bid, status: "active" };
  if (sid === "__unassigned__") q.$or = [{ section_id: "" }, { section_id: { $exists: false } }];
  else if (sid) q.section_id = sid;
  const ids = await distinctStudentIdsForQuery(q);
  if (mode === "enrollment") return { role: "student", _id: { $in: ids } };
  const unionIds = await unionWithLegacy(catalogBatchStudentFilter(batchId, rawSection), ids);
  return { role: "student", _id: { $in: unionIds } };
}

/**
 * Read-switch helper for per-student content visibility. Returns the attached membership set
 * (present only in non-legacy mode, after scopeStudentToBatch) — otherwise the caller's EXACT
 * legacy value(s). This guarantees byte-identical behavior in legacy mode while widening to the
 * full batch set once the flag is flipped.
 */
function membershipKeysOr(student, legacyFallback) {
  if (student && Array.isArray(student.__membershipBatchIds)) return student.__membershipBatchIds;
  return Array.isArray(legacyFallback) ? legacyFallback : [];
}

module.exports = {
  resolveStudentBatchContext,
  scopeStudentToBatch,
  membershipMode,
  enrollmentBatchIdsForStudent,
  resolveStudentBatchIds,
  membershipKeysOr,
  studentIdsInBatches,
  catalogBatchMongoMatchResolved,
  studentsInBatchesFilterResolved,
  catalogBatchStudentFilterResolved,
};
