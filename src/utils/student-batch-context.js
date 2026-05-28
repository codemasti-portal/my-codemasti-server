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
const { catalogBatchIdsFromStudentLean } = require("./enrollment");

async function resolveStudentBatchContext(req, student) {
  const requested = String(req?.query?.batch_id || "").trim().toLowerCase();

  if (requested && student?._id) {
    const enrolled = await StudentEnrollment.findOne({
      student_id: student._id,
      status: "active",
    })
      .populate({ path: "course_id", match: { linked_batch_id: requested }, select: "linked_batch_id" })
      .lean();
    if (enrolled?.course_id?.linked_batch_id === requested) {
      return { batchId: requested, batchIds: [requested], explicit: true };
    }
    // Invalid/unauthorized — silently fall through.
  }

  const fallback = String(student?.batch_id || "").trim().toLowerCase();
  return {
    batchId: fallback,
    batchIds: catalogBatchIdsFromStudentLean(student),
    explicit: false,
  };
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
  return ctx;
}

module.exports = { resolveStudentBatchContext, scopeStudentToBatch };
