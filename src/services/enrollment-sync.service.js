/**
 * Keeps StudentEnrollment in sync with Student.batch_id.
 *
 * Trigger: admin renames a student's enrollment_number (which derives a new batch_id).
 *   e.g. I260189 (Innovators) → S260189 (Spark)
 *
 * Without this sync, the student's StudentEnrollment still points at Innovators while
 * Student.batch_id reads "spark" — bulk-generate misses them for Spark and includes them
 * for Innovators (if Innovators is still active).
 *
 * Behavior:
 *   - Old batch → new batch, both have linked courses:
 *       active enrollment for old course → mark "completed" (ended_on = now)
 *       create new active enrollment in new course (Mongo transaction)
 *   - New batch has no linked course (e.g. student moved to a batch we haven't created a Course for):
 *       leave existing enrollment alone, return reason
 *   - No active enrollment for old course (e.g. legacy student never backfilled):
 *       just create new enrollment for the new course if a course exists
 *   - Old/new batch_id equal: no-op
 */

const mongoose = require("mongoose");
const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");

async function findCourseByBatchId(batchId) {
  if (!batchId) return null;
  return Course.findOne({ linked_batch_id: String(batchId).toLowerCase(), is_active: true })
    .select("_id code name linked_batch_id")
    .lean();
}

async function syncEnrollmentToBatch({ studentId, oldBatchId, newBatchId, actorStaffId }) {
  const oldBid = (oldBatchId || "").toLowerCase().trim();
  const newBid = (newBatchId || "").toLowerCase().trim();

  if (!studentId) return { changed: false, action: "skipped_no_student" };
  if (oldBid === newBid) return { changed: false, action: "no_change" };

  const [oldCourse, newCourse] = await Promise.all([
    findCourseByBatchId(oldBid),
    findCourseByBatchId(newBid),
  ]);

  if (!newCourse) {
    return {
      changed: false,
      action: "skipped_no_target_course",
      old_batch_id: oldBid,
      new_batch_id: newBid,
      detail: newBid
        ? `No active Course has linked_batch_id="${newBid}". Create one in Billing → Courses or leave manual.`
        : "Student no longer has a batch_id; no course to enroll in.",
    };
  }

  // Find an existing active enrollment in the old course (if any).
  const oldEnrollment = oldCourse
    ? await StudentEnrollment.findOne({
        student_id: studentId,
        course_id: oldCourse._id,
        status: "active",
      })
    : null;

  // Find an existing enrollment (any status) in the new course — avoid duplicating.
  const existingNew = await StudentEnrollment.findOne({
    student_id: studentId,
    course_id: newCourse._id,
    status: { $in: ["active", "completed"] },
  });

  // If they already have an active enrollment in the new course → just close out the old one.
  if (existingNew && existingNew.status === "active") {
    if (oldEnrollment) {
      oldEnrollment.status = "completed";
      if (!oldEnrollment.ended_on) oldEnrollment.ended_on = new Date();
      oldEnrollment.notes = `${oldEnrollment.notes ? oldEnrollment.notes + "\n" : ""}Auto-completed: student moved to batch "${newBid}".`;
      await oldEnrollment.save();
      return {
        changed: true,
        action: "old_completed_new_already_active",
        old_course: { id: String(oldCourse._id), code: oldCourse.code, name: oldCourse.name },
        new_course: { id: String(newCourse._id), code: newCourse.code, name: newCourse.name },
      };
    }
    return { changed: false, action: "already_active_in_new" };
  }

  const session = await mongoose.startSession();
  let createdId = null;
  try {
    await session.withTransaction(async () => {
      if (oldEnrollment) {
        oldEnrollment.status = "completed";
        if (!oldEnrollment.ended_on) oldEnrollment.ended_on = new Date();
        oldEnrollment.notes = `${oldEnrollment.notes ? oldEnrollment.notes + "\n" : ""}Auto-completed: student moved to batch "${newBid}".`;
        await oldEnrollment.save({ session });
      }

      if (existingNew) {
        // existingNew.status was "completed" — reactivate it instead of creating a duplicate.
        existingNew.status = "active";
        existingNew.ended_on = null;
        existingNew.notes = `${existingNew.notes ? existingNew.notes + "\n" : ""}Auto-reactivated: student moved back to batch "${newBid}".`;
        await existingNew.save({ session });
        createdId = String(existingNew._id);
      } else {
        const docs = await StudentEnrollment.create(
          [
            {
              student_id: studentId,
              course_id: newCourse._id,
              status: "active",
              started_on: new Date(),
              notes: `Auto-created: student moved to batch "${newBid}"${oldBid ? ` from "${oldBid}"` : ""}.`,
              created_by_staff_id: actorStaffId || null,
            },
          ],
          { session }
        );
        createdId = String(docs[0]._id);
      }
    });
  } finally {
    session.endSession();
  }

  return {
    changed: true,
    action: oldEnrollment ? "transitioned" : "created",
    old_course: oldCourse ? { id: String(oldCourse._id), code: oldCourse.code, name: oldCourse.name } : null,
    new_course: { id: String(newCourse._id), code: newCourse.code, name: newCourse.name },
    new_enrollment_id: createdId,
  };
}

/**
 * Find all active students whose Student.batch_id doesn't match any active enrollment.
 * Returns mismatches; if apply=true, fixes each via syncEnrollmentToBatch.
 */
async function reconcileAllStudents({ apply = false, actorStaffId = null } = {}) {
  const Student = require("../models/Student");
  // Only students with a batch_id we care about
  const students = await Student.find({
    role: "student",
    batch_id: { $exists: true, $ne: "", $ne: null },
  })
    .select("_id name email batch_id enrollment_number")
    .lean();

  const courses = await Course.find({ is_active: true })
    .select("_id code name linked_batch_id")
    .lean();
  const courseByBatchId = new Map(
    courses
      .filter((c) => c.linked_batch_id)
      .map((c) => [String(c.linked_batch_id).toLowerCase(), c])
  );

  const mismatches = [];
  const actions = [];

  for (const s of students) {
    const wantedBatch = String(s.batch_id || "").toLowerCase();
    const wantedCourse = courseByBatchId.get(wantedBatch);
    if (!wantedCourse) continue; // skip if no course exists for this batch yet

    const activeEnrollments = await StudentEnrollment.find({
      student_id: s._id,
      status: "active",
    }).select("course_id").lean();

    // Is there an active enrollment that matches the wanted course?
    const matches = activeEnrollments.some(
      (e) => String(e.course_id) === String(wantedCourse._id)
    );
    if (matches) continue;

    // Determine "old" batch_id from any active enrollment they DO have
    let oldBatchId = "";
    for (const e of activeEnrollments) {
      const c = courses.find((cc) => String(cc._id) === String(e.course_id));
      if (c?.linked_batch_id) {
        oldBatchId = c.linked_batch_id;
        break;
      }
    }

    mismatches.push({
      student: { id: String(s._id), name: s.name, email: s.email, enrollment_number: s.enrollment_number, batch_id: s.batch_id },
      expected_course: { id: String(wantedCourse._id), code: wantedCourse.code, name: wantedCourse.name },
      current_active_enrollments: activeEnrollments.length,
    });

    if (apply) {
      try {
        const result = await syncEnrollmentToBatch({
          studentId: s._id,
          oldBatchId,
          newBatchId: wantedBatch,
          actorStaffId,
        });
        actions.push({ student_id: String(s._id), result });
      } catch (err) {
        actions.push({ student_id: String(s._id), error: err.message });
      }
    }
  }

  return { mismatches, fixed: apply ? actions.filter((a) => a.result?.changed).length : 0, actions };
}

module.exports = { syncEnrollmentToBatch, reconcileAllStudents };
