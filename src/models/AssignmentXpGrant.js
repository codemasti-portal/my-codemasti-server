const mongoose = require("mongoose");

const assignmentXpGrantSchema = new mongoose.Schema(
  {
    assignment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
      index: true,
    },
    question_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AssignmentQuestion",
      required: true,
      index: true,
    },
    student_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    xp_awarded: { type: Number, required: true, min: 0 },
    full_xp: { type: Number, required: true, min: 0 },
    submitted_before_deadline: { type: Boolean, default: true },
    submitted_at: { type: Date, required: true, index: true },
    deadline_date: { type: Date, default: null },
    granted_at: { type: Date, default: Date.now, index: true },
    source_submission_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AssignmentSubmission",
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

assignmentXpGrantSchema.index(
  { assignment_id: 1, question_id: 1, student_id: 1 },
  { unique: true, name: "uniq_assignment_question_student_xp_grant" }
);

module.exports = mongoose.model("AssignmentXpGrant", assignmentXpGrantSchema);
