const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const StudentEnrollment = require("../models/StudentEnrollment");
const Student = require("../models/Student");
const Course = require("../models/Course");
const Invoice = require("../models/Invoice");
const { reconcileAllStudents } = require("../services/enrollment-sync.service");

const createSchema = z.object({
  student_id: z.string().min(1),
  course_id: z.string().min(1),
  status: z.enum(["active", "completed", "cancelled"]).optional().default("active"),
  started_on: z.coerce.date().optional(),
  ended_on: z.coerce.date().nullable().optional(),
  fee_override_paise: z.number().int().min(0).nullable().optional(),
  notes: z.string().max(2000).optional().default(""),
});

const patchSchema = z.object({
  status: z.enum(["active", "completed", "cancelled"]).optional(),
  started_on: z.coerce.date().optional(),
  ended_on: z.coerce.date().nullable().optional(),
  fee_override_paise: z.number().int().min(0).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

const transitionSchema = z.object({
  target_course_id: z.string().min(1),
  started_on: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});

function toRow(e, populated = {}) {
  const c = populated.course;
  const s = populated.student;
  return {
    id: String(e._id),
    student_id: String(e.student_id?._id || e.student_id),
    course_id: String(e.course_id?._id || e.course_id),
    status: e.status,
    started_on: e.started_on,
    ended_on: e.ended_on,
    fee_override_paise: e.fee_override_paise ?? null,
    notes: e.notes || "",
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    student: s
      ? { id: String(s._id), name: s.name, email: s.email, enrollment_number: s.enrollment_number || "" }
      : null,
    course: c
      ? { id: String(c._id), code: c.code, name: c.name, category: c.category, base_fee_paise: c.base_fee_paise }
      : null,
  };
}

async function listEnrollments(req, res) {
  const { student_id, course_id, status, q } = req.query || {};
  const filter = {};
  if (student_id && mongoose.Types.ObjectId.isValid(student_id)) filter.student_id = student_id;
  if (course_id && mongoose.Types.ObjectId.isValid(course_id)) filter.course_id = course_id;
  if (status) filter.status = String(status);

  let studentMatchIds = null;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matched = await Student.find({ $or: [{ name: rx }, { email: rx }, { enrollment_number: rx }] })
      .select("_id")
      .limit(200)
      .lean();
    studentMatchIds = matched.map((s) => s._id);
    if (filter.student_id) {
      if (!studentMatchIds.some((id) => String(id) === String(filter.student_id))) {
        return sendSuccess(res, []);
      }
    } else {
      filter.student_id = { $in: studentMatchIds };
    }
  }

  const rows = await StudentEnrollment.find(filter)
    .populate({ path: "course_id" })
    .populate({ path: "student_id", select: "name email enrollment_number" })
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean();

  return sendSuccess(
    res,
    rows.map((e) => toRow(e, { course: e.course_id, student: e.student_id }))
  );
}

async function getEnrollment(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const e = await StudentEnrollment.findById(id)
    .populate({ path: "course_id" })
    .populate({ path: "student_id", select: "name email enrollment_number" })
    .lean();
  if (!e) return sendError(res, 404, "NOT_FOUND", "Enrollment not found");
  return sendSuccess(res, toRow(e, { course: e.course_id, student: e.student_id }));
}

async function createEnrollment(req, res) {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const body = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(body.student_id) || !mongoose.Types.ObjectId.isValid(body.course_id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid student_id or course_id");
  }

  const [student, course] = await Promise.all([
    Student.findById(body.student_id).select("_id name").lean(),
    Course.findById(body.course_id).select("_id is_active code").lean(),
  ]);
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  if (!course) return sendError(res, 404, "COURSE_NOT_FOUND", "Course not found");
  if (!course.is_active) return sendError(res, 409, "COURSE_INACTIVE", "Course is archived");

  try {
    const doc = await StudentEnrollment.create({
      ...body,
      created_by_staff_id: req.staff?.sub,
    });
    return sendSuccess(res, toRow(doc.toObject()), "Enrollment created");
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 409, "DUPLICATE_ENROLLMENT", "Student already has an active/completed enrollment in this course");
    }
    return sendError(res, 500, "CREATE_FAILED", err.message);
  }
}

async function updateEnrollment(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const doc = await StudentEnrollment.findById(id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Enrollment not found");
  Object.assign(doc, parsed.data);
  if (parsed.data.status === "completed" && !doc.ended_on) doc.ended_on = new Date();
  await doc.save();
  return sendSuccess(res, toRow(doc.toObject()), "Enrollment updated");
}

/** POST /admin/enrollments/:id/transition — completes this enrollment + creates a new one. Convenience helper. */
async function transitionEnrollment(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const parsed = transitionSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const { target_course_id, started_on, notes } = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(target_course_id)) return sendError(res, 400, "INVALID_ID", "Invalid target_course_id");

  const current = await StudentEnrollment.findById(id);
  if (!current) return sendError(res, 404, "NOT_FOUND", "Source enrollment not found");
  const targetCourse = await Course.findById(target_course_id).select("_id is_active").lean();
  if (!targetCourse) return sendError(res, 404, "COURSE_NOT_FOUND", "Target course not found");
  if (!targetCourse.is_active) return sendError(res, 409, "COURSE_INACTIVE", "Target course is archived");

  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      current.status = "completed";
      if (!current.ended_on) current.ended_on = new Date();
      await current.save({ session });

      const newDocs = await StudentEnrollment.create(
        [
          {
            student_id: current.student_id,
            course_id: targetCourse._id,
            status: "active",
            started_on: started_on || new Date(),
            notes: notes || `Transitioned from enrollment ${current._id}`,
            created_by_staff_id: req.staff?.sub,
          },
        ],
        { session }
      );
      created = newDocs[0];
    });
  } catch (err) {
    session.endSession();
    if (err.code === 11000) {
      return sendError(res, 409, "DUPLICATE_ENROLLMENT", "Student already has an active/completed enrollment in the target course");
    }
    return sendError(res, 500, "TRANSITION_FAILED", err.message);
  }
  session.endSession();

  return sendSuccess(
    res,
    {
      completed: toRow(current.toObject()),
      created: toRow(created.toObject()),
    },
    "Transition complete"
  );
}

async function deleteEnrollment(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const enrollment = await StudentEnrollment.findById(id).select("status").lean();
  if (!enrollment) return sendError(res, 404, "NOT_FOUND", "Enrollment not found");

  // Block if any invoices exist for this enrollment — preserves financial history.
  const invoiceCount = await Invoice.countDocuments({ enrollment_id: id });
  if (invoiceCount > 0) {
    return sendError(
      res,
      409,
      "DELETE_BLOCKED",
      `Cannot delete: ${invoiceCount} invoice(s) exist for this enrollment. Set status to "cancelled" instead.`
    );
  }

  await StudentEnrollment.deleteOne({ _id: id });
  return sendSuccess(res, { id }, "Enrollment deleted");
}

/**
 * Find (and optionally fix) students whose Student.batch_id doesn't match any active enrollment.
 * Common cause: enrollment_number renamed (I260189 → S260189) without the StudentEnrollment being moved.
 *
 *   GET  /admin/enrollments/reconcile       → dry-run, returns mismatches only
 *   POST /admin/enrollments/reconcile       → applies fixes
 */
async function reconcileEnrollments(req, res) {
  const apply = req.method === "POST";
  try {
    const result = await reconcileAllStudents({ apply, actorStaffId: req.staff?.sub });
    return sendSuccess(
      res,
      result,
      apply
        ? `Reconciled ${result.fixed} enrollment(s).`
        : `Found ${result.mismatches.length} mismatch(es). POST to apply.`
    );
  } catch (err) {
    return sendError(res, 500, "RECONCILE_FAILED", err.message);
  }
}

module.exports = { listEnrollments, getEnrollment, createEnrollment, updateEnrollment, transitionEnrollment, deleteEnrollment, reconcileEnrollments };
