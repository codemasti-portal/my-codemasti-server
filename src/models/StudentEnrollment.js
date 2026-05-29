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

module.exports = mongoose.model("StudentEnrollment", studentEnrollmentSchema);
module.exports.ENROLLMENT_STATUSES = ENROLLMENT_STATUSES;
