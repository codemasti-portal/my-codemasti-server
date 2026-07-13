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
 * Authoritative membership resolver: a student's active batch ids (+ per-batch sections) from
 * their enrollments.
 * @param {object|string} studentOrId  a lean Student doc (preferred) or a student id
 */
async function resolveStudentBatchIds(studentOrId) {
  const studentId = studentOrId && typeof studentOrId === "object" ? studentOrId._id : studentOrId;
  const { batchIds, sectionByBatch } = await enrollmentBatchIdsForStudent(studentId);
  return { batchIds, sectionByBatch };
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
  const { batchIds } = await resolveStudentBatchIds(student);
  return { batchId: fallback, batchIds, explicit: false };
}

/**
 * Same as enrollmentBatchIdsForStudent, but also includes "completed" enrollments —
 * i.e. every batch the student has EVER belonged to, not just their current one(s).
 * For HISTORY only (past contests, past invoices): a lapsed/completed enrollment must
 * never grant access to anything happening now or in the future, only to records from
 * when the enrollment was still active. Callers are responsible for that phase/date gate.
 */
async function historicalEnrollmentBatchIdsForStudent(studentId) {
  if (!studentId) return { batchIds: [] };
  const rows = await StudentEnrollment.find({
    student_id: studentId,
    status: { $in: ["active", "completed"] },
  })
    .select("batch_id course_id")
    .lean();
  const ids = new Set();
  const needCourse = [];
  for (const r of rows) {
    const bid = String(r.batch_id || "").toLowerCase().trim();
    if (bid) ids.add(bid);
    else if (r.course_id) needCourse.push(r);
  }
  if (needCourse.length) {
    const courseIds = [...new Set(needCourse.map((r) => String(r.course_id)))];
    const courses = await Course.find({ _id: { $in: courseIds } }).select("linked_batch_id").lean();
    const byId = new Map(courses.map((c) => [String(c._id), String(c.linked_batch_id || "").toLowerCase().trim()]));
    for (const r of needCourse) {
      const bid = byId.get(String(r.course_id));
      if (bid) ids.add(bid);
    }
  }
  return { batchIds: [...ids] };
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
  // Attach the resolved membership set so the sync chokepoint (catalogBatchIdsFromStudentLean) returns it.
  if (student) {
    student.__membershipBatchIds = ctx.batchIds;
    // True when the student (via the course switcher) explicitly scoped this request to ONE
    // specific batch. Callers that widen visibility across a student's OTHER batches (e.g. past
    // contests from a batch they've since left) must skip that widening when this is true —
    // an explicit pick means "show me only this course," full stop.
    student.__membershipExplicit = ctx.explicit;
  }
  return ctx;
}

// ---- Cohort resolution ("which students are in batch X") ----
// Each *Resolved wrapper returns a Student.find filter scoped to the active-enrollment members of
// the batch(es) (M:N membership).

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

/** Spreadable Student.find partial for the active-enrollment members of one batch. */
async function catalogBatchMongoMatchResolved(batchId) {
  return { _id: { $in: await studentIdsInBatches([batchId]) } };
}

/**
 * Same "one board" resolution as the leaderboard's default (primary batch, else first) — used
 * wherever a batch-scoped roster is needed without an explicit requested-batch override (Rarity
 * Tags, the "Closed the Gap" badge check). The leaderboard controller keeps its own version since
 * it additionally supports an explicit `?batch_id=` override from a client-side batch switcher.
 */
async function resolveDefaultBatchBoard(studentLean) {
  const { batchIds } = await resolveStudentBatchIds(studentLean?._id);
  if (!batchIds.length) return { board: null, ids: [], batchName: "" };
  const primary = String(studentLean?.batch_id || "").toLowerCase().trim();
  const board = (primary && batchIds.includes(primary) && primary) || batchIds[0];
  const ids = await studentIdsInBatches([board]);
  // eslint-disable-next-line global-require -- lazy to sidestep any load-order assumptions on the registry
  const registry = require("./batch-catalog-registry");
  return { board, ids, batchName: registry.displayNameSync(board) || board };
}

/** Full Student.find filter for a set of batches + section (mirrors studentsInCatalogBatchesFilter). */
async function studentsInBatchesFilterResolved(batchKeys, opts = {}) {
  const ids = await studentIdsInBatches(batchKeys, opts);
  return { role: "student", _id: { $in: ids } };
}

/** Full Student.find filter for one batch + raw section (mirrors catalogBatchStudentFilter). */
async function catalogBatchStudentFilterResolved(batchId, rawSection) {
  const bid = String(batchId || "").toLowerCase().trim();
  const hasSection = rawSection !== undefined && String(rawSection).trim() !== "";
  const sid = hasSection ? String(rawSection).trim().toLowerCase().replace(/\s+/g, "-") : "";
  const q = { batch_id: bid, status: "active" };
  if (sid === "__unassigned__") q.$or = [{ section_id: "" }, { section_id: { $exists: false } }];
  else if (sid) q.section_id = sid;
  return { role: "student", _id: { $in: await distinctStudentIdsForQuery(q) } };
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
  enrollmentBatchIdsForStudent,
  historicalEnrollmentBatchIdsForStudent,
  resolveStudentBatchIds,
  membershipKeysOr,
  studentIdsInBatches,
  catalogBatchMongoMatchResolved,
  studentsInBatchesFilterResolved,
  catalogBatchStudentFilterResolved,
  resolveDefaultBatchBoard,
};
