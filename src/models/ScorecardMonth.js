const mongoose = require("mongoose");

const componentSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    obtained: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    status: { type: String, default: "" },
  },
  { _id: false }
);

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    components: [componentSchema],
  },
  { _id: false }
);

const scorecardMonthSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    month_key: { type: String, required: true, trim: true, index: true },
    subjects: [subjectSchema],
    monthly_test: {
      test_name: { type: String, default: "" },
      test_type: { type: String, default: "" },
      scholarship_scope: { type: String, default: "none" },
      obtained: { type: Number, default: 0 },
      total: { type: Number, default: 100 },
      note: { type: String, default: "" },
    },
    next_month_fee: {
      actual_fee: { type: Number, default: 0 },
      scholarship_percent: { type: Number, default: 0 },
      scholarship_amount: { type: Number, default: 0 },
      final_fee: { type: Number, default: 0 },
      note: { type: String, default: "" },
    },
    tests: {
      type: [
        {
          test_name: { type: String, default: "" },
          test_type: { type: String, default: "" },
          monthly_test: {
            test_name: { type: String, default: "" },
            test_type: { type: String, default: "" },
            scholarship_scope: { type: String, default: "none" },
            obtained: { type: Number, default: 0 },
            total: { type: Number, default: 100 },
            note: { type: String, default: "" },
          },
          next_month_fee: {
            actual_fee: { type: Number, default: 0 },
            scholarship_percent: { type: Number, default: 0 },
            scholarship_amount: { type: Number, default: 0 },
            final_fee: { type: Number, default: 0 },
            note: { type: String, default: "" },
          },
          audit: {
            updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
            updated_by_name: { type: String, default: "" },
            updated_at: { type: Date, default: null },
          },
        },
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false }
);

scorecardMonthSchema.index({ student_id: 1, month_key: 1 }, { unique: true });

module.exports = mongoose.model("ScorecardMonth", scorecardMonthSchema);
