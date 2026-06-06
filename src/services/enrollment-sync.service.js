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
 * Next per-batch roll number for a batch: prefix + YY + 4-digit sequence, e.g. "B260012".
 * Returns "" if the batch has no enrollment_prefix (no roll-number identity). (Decision #7b: auto-gen.)
 */
async function generateRollNumberForBatch(batchId) {
  const bid = String(batchId || "").toLowerCase().trim();
  if (!bid) return "";
  const registry = require("../utils/batch-catalog-registry");
  await registry.refresh();
  const prefix = registry.batchIdToPrefixSync(bid);
  if (!prefix) return "";
  const yy = String(new Date().getFullYear()).slice(-2);
  const rx = new RegExp(`^${prefix}${yy}(\\d{4})$`, "i");
  const rows = await StudentEnrollment.find({ batch_id: bid, roll_number: rx }).select("roll_number").lean();
  let max = 0;
  for (const r of rows) {
    const m = rx.exec(String(r.roll_number || ""));
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `${prefix}${yy}${String(max + 1).padStart(4, "0")}`;
}

/**
 * ADDITIVE multi-batch "add" primitive: ensure the student has an ACTIVE enrollment in the course
 * linked to `batchId`. Never touches the student's other enrollments. Reuses a prior
 * completed/cancelled row for the same course (the partial-unique index forbids two active/completed
 * rows per course); otherwise creates a new one. Auto-assigns a per-batch roll number (#7b).
 */
async function addStudentToBatch({ studentId, batchId, sectionId = "", actorStaffId = null, source = "admin_manual" }) {
  const bid = String(batchId || "").toLowerCase().trim();
  if (!studentId || !bid) return { changed: false, action: "skipped_invalid" };

  const course = await findCourseByBatchId(bid);
  if (!course) {
    return {
      changed: false,
      action: "skipped_no_course",
      batch_id: bid,
      detail: `No active Course is linked to batch "${bid}". Create one in Billing → Courses first.`,
    };
  }
  const courseInfo = { id: String(course._id), code: course.code, name: course.name };

  const existingActive = await StudentEnrollment.findOne({
    student_id: studentId,
    course_id: course._id,
    status: "active",
  });
  if (existingActive) {
    let touched = false;
    if (!existingActive.batch_id) { existingActive.batch_id = bid; touched = true; }
    if (sectionId && existingActive.section_id !== sectionId) { existingActive.section_id = sectionId; touched = true; }
    if (touched) await existingActive.save();
    return { changed: touched, action: "already_active", enrollment_id: String(existingActive._id), course: courseInfo, batch_id: bid };
  }

  // Reuse a prior completed/cancelled enrollment for this course rather than creating a duplicate.
  const reusable = await StudentEnrollment.findOne({
    student_id: studentId,
    course_id: course._id,
    status: { $in: ["completed", "cancelled"] },
  }).sort({ updatedAt: -1 });
  if (reusable) {
    reusable.status = "active";
    reusable.ended_on = null;
    if (!reusable.batch_id) reusable.batch_id = bid;
    if (sectionId) reusable.section_id = sectionId;
    if (!reusable.roll_number) reusable.roll_number = await generateRollNumberForBatch(bid);
    reusable.notes = `${reusable.notes ? reusable.notes + "\n" : ""}Reactivated: added to batch "${bid}".`;
    await reusable.save();
    return { changed: true, action: "reactivated", enrollment_id: String(reusable._id), roll_number: reusable.roll_number || "", course: courseInfo, batch_id: bid };
  }

  // Create with an auto-assigned per-batch roll number; retry on a roll_number race.
  let created = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const rollNumber = await generateRollNumberForBatch(bid);
    try {
      const docs = await StudentEnrollment.create([
        {
          student_id: studentId,
          course_id: course._id,
          status: "active",
          started_on: new Date(),
          batch_id: bid,
          section_id: sectionId || "",
          roll_number: rollNumber,
          source,
          notes: `Added to batch "${bid}".`,
          created_by_staff_id: actorStaffId || null,
        },
      ]);
      created = docs[0];
      break;
    } catch (err) {
      if (err && err.code === 11000 && attempt < 3) continue; // roll_number collision → regenerate
      throw err;
    }
  }
  return { changed: true, action: "created", enrollment_id: String(created._id), roll_number: created.roll_number || "", course: courseInfo, batch_id: bid };
}

/**
 * Targeted multi-batch "remove" primitive: complete the student's ACTIVE enrollment(s) for `batchId`
 * only. Every other batch's enrollment is left untouched. Marks "completed" (not deleted) so invoices
 * and history are preserved.
 */
async function removeStudentFromBatch({ studentId, batchId, actorStaffId = null }) {
  const bid = String(batchId || "").toLowerCase().trim();
  if (!studentId || !bid) return { changed: false, action: "skipped_invalid" };

  const course = await findCourseByBatchId(bid);
  const or = [{ batch_id: bid }];
  if (course) or.push({ course_id: course._id });
  const enrollments = await StudentEnrollment.find({ student_id: studentId, status: "active", $or: or });
  if (!enrollments.length) return { changed: false, action: "not_enrolled", batch_id: bid };

  const Invoice = require("../models/Invoice");
  let cancelledInvoices = 0;
  for (const e of enrollments) {
    e.status = "completed";
    if (!e.ended_on) e.ended_on = new Date();
    e.notes = `${e.notes ? e.notes + "\n" : ""}Removed from batch "${bid}".`;
    await e.save();
    // Decision #3: cancel UNPAID (pending) invoices for this batch going forward; keep paid months.
    const r = await Invoice.updateMany(
      { enrollment_id: e._id, status: "pending" },
      { $set: { status: "cancelled", notes: `Auto-cancelled: student removed from batch "${bid}".` } }
    );
    cancelledInvoices += r.modifiedCount || 0;
  }
  return { changed: true, action: "removed", count: enrollments.length, cancelled_invoices: cancelledInvoices, batch_id: bid };
}

/**
 * Find all active students whose Student.batch_id is not reflected by an ACTIVE enrollment.
 * ADDITIVE: when apply=true, ensures the wanted batch's enrollment exists via addStudentToBatch —
 * it never completes the student's other active enrollments, so a genuine multi-batch student is
 * never collapsed (multi-batch safe; replaces the old transition-based reconcile).
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

    mismatches.push({
      student: { id: String(s._id), name: s.name, email: s.email, enrollment_number: s.enrollment_number, batch_id: s.batch_id },
      expected_course: { id: String(wantedCourse._id), code: wantedCourse.code, name: wantedCourse.name },
      current_active_enrollments: activeEnrollments.length,
    });

    if (apply) {
      try {
        // Additive: ensure the wanted batch's enrollment exists. Never completes the student's
        // other active enrollments — a student may legitimately belong to multiple batches.
        const result = await addStudentToBatch({
          studentId: s._id,
          batchId: wantedBatch,
          actorStaffId,
          source: "migration_backfill",
        });
        actions.push({ student_id: String(s._id), result });
      } catch (err) {
        actions.push({ student_id: String(s._id), error: err.message });
      }
    }
  }

  return { mismatches, fixed: apply ? actions.filter((a) => a.result?.changed).length : 0, actions };
}

/**
 * Keep the legacy primary-batch cache (Student.batch_id/batch/section_id) usable after a membership
 * change. CONSERVATIVE: only FILLS an EMPTY primary (e.g. a student whose first batch was added via
 * add-batch and who has no enrollment_number). It never overwrites a non-empty primary, so it can't
 * fight the enrollment_number-derived primary (which legacy display/identity owns).
 */
async function recomputePrimaryBatchCache(studentId) {
  if (!studentId) return;
  const Student = require("../models/Student");
  const student = await Student.findById(studentId).select("batch_id batch section_id");
  if (!student) return;
  if (String(student.batch_id || "").trim()) return; // primary already set — leave it alone

  const e = await StudentEnrollment.findOne({ student_id: studentId, status: "active" })
    .select("batch_id section_id")
    .sort({ started_on: 1 })
    .lean();
  const bid = e ? String(e.batch_id || "").toLowerCase().trim() : "";
  if (!bid) return;

  const registry = require("../utils/batch-catalog-registry");
  student.batch_id = bid;
  student.batch = registry.displayNameSync(bid) || student.batch || "";
  if (e.section_id) student.section_id = e.section_id;
  await student.save();
}

module.exports = {
  syncEnrollmentToBatch,
  reconcileAllStudents,
  addStudentToBatch,
  removeStudentFromBatch,
  recomputePrimaryBatchCache,
  generateRollNumberForBatch,
};
