const mongoose = require("mongoose");

const ENROLLMENT_STATUSES = ["active", "completed", "cancelled"];

const studentEnrollmentSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    course_id: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: "active", index: true },
    started_on: { type: Date, default: Date.now },
    ended_on: { type: Date, default: null },
    fee_override_paise: { type: Number, default: null, min: 0 },
    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    created_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },

    // --- Phase 1 (additive, dual-write): batch membership denormalized onto the enrollment ---
    // Auto-populated from the enrolled Course.linked_batch_id (see pre-save hook below). "" = course
    // not batch-linked. This is the future M:N membership key; readers still use the legacy path
    // until the read-switch phase.
    batch_id: { type: String, default: "", lowercase: true, trim: true },
    // Per-batch section (a student can be in different sections across batches). "" = all sections.
    section_id: { type: String, default: "", lowercase: true, trim: true },
    // Provenance of this enrollment (free-form for now): admin_manual | enrollment_number | migration_backfill | self_select.
    source: { type: String, default: "" },
    // Per-batch roll number (the student's roll IN this batch), e.g. "B260012". Auto-generated on
    // add-batch when the batch has an enrollment_prefix. Distinct from Student.enrollment_number
    // (the primary identity). "" = not assigned (batch has no prefix).
    roll_number: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

studentEnrollmentSchema.index({ student_id: 1, status: 1 });

// A student can re-enroll into the same course only if prior enrollments are not active/completed.
// Partial unique index: blocks duplicates when status is active or completed; cancelled re-enrollments allowed.
studentEnrollmentSchema.index(
  { student_id: 1, course_id: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["active", "completed"] } } }
);

// Phase 1 hot paths: "who is in batch X" and "what batches is student S in".
studentEnrollmentSchema.index({ batch_id: 1, status: 1 });
studentEnrollmentSchema.index({ student_id: 1, batch_id: 1, status: 1 });

// Per-batch roll number uniqueness (only for rows that have one).
studentEnrollmentSchema.index(
  { batch_id: 1, roll_number: 1 },
  { unique: true, partialFilterExpression: { roll_number: { $type: "string", $ne: "" } } }
);

// Dual-write: denormalize batch_id from the enrolled Course.linked_batch_id when not already set.
// Defensive — only fills when empty, never throws, leaves "" if the course can't be resolved.
studentEnrollmentSchema.pre("save", async function fillBatchIdFromCourse() {
  try {
    if (this.batch_id || !this.course_id) return;
    const Course = require("./Course");
    const c = await Course.findById(this.course_id).select("linked_batch_id").lean();
    if (c && c.linked_batch_id) this.batch_id = String(c.linked_batch_id).toLowerCase().trim();
  } catch (_e) {
    /* never block an enrollment save on the denormalization lookup */
  }
});

// Same dual-write for bulk inserts.
studentEnrollmentSchema.pre("insertMany", async function fillBatchIdsForBulk(next, docs) {
  try {
    const Course = require("./Course");
    const ids = [...new Set((docs || []).map((d) => d.course_id).filter(Boolean).map(String))];
    if (ids.length) {
      const courses = await Course.find({ _id: { $in: ids } }).select("linked_batch_id").lean();
      const byId = new Map(courses.map((c) => [String(c._id), String(c.linked_batch_id || "").toLowerCase().trim()]));
      for (const d of docs || []) {
        const bid = byId.get(String(d.course_id));
        if (!d.batch_id && bid) d.batch_id = bid;
      }
    }
  } catch (_e) {
    /* ignore */
  }
  next();
});

module.exports = mongoose.model("StudentEnrollment", studentEnrollmentSchema);
module.exports.ENROLLMENT_STATUSES = ENROLLMENT_STATUSES;
