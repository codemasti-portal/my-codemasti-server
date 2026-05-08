const mongoose = require("mongoose");

const scorecardEntrySchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, lowercase: true, trim: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    /** Optional link to a structured test definition. */
    test_id: { type: mongoose.Schema.Types.ObjectId, ref: "ScorecardTest", default: null, index: true },
    /** Denormalized from test for filtering / legacy rows. */
    exam_type: { type: String, default: "", trim: true, maxlength: 64 },
    exam_date: { type: Date, default: null },
    /** Calendar month for grouping, e.g. `2026-05`. */
    assessment_period: { type: String, required: true, trim: true },
    task_label: { type: String, required: true, trim: true, maxlength: 200 },
    total_marks: { type: Number, required: true, min: 0 },
    marks_obtained: { type: Number, required: true, min: 0 },
    scholarship_percent: { type: Number, default: null, min: 0, max: 100 },
    scholarship_amount: { type: Number, default: null, min: 0 },
    performance_status: { type: String, default: "", maxlength: 120 },
    batch_recommendation: { type: String, default: "", trim: true, maxlength: 80 },
    next_month_fee: { type: Number, default: null, min: 0 },
    notes: { type: String, default: "", maxlength: 2000 },
    updated_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

scorecardEntrySchema.index({ student_id: 1, assessment_period: 1, task_label: 1 }, { unique: true });

module.exports = mongoose.model("ScorecardEntry", scorecardEntrySchema);
