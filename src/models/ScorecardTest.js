const mongoose = require("mongoose");

const TEST_TYPES = [
  "scholarship_test",
  "performance_test",
  "monthly_test",
  "cst",
  "mock_test",
  "random_test",
  "custom_test",
];

const scorecardTestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    test_type: { type: String, required: true, trim: true, lowercase: true, enum: TEST_TYPES },
    exam_date: { type: Date, required: true },
    total_marks: { type: Number, required: true, min: 0 },
    scholarship_rules: { type: String, default: "", maxlength: 8000 },
    batch_allocation_rules: { type: String, default: "", maxlength: 8000 },
    description: { type: String, default: "", maxlength: 4000 },
    is_active: { type: Boolean, default: true },
    updated_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

scorecardTestSchema.index({ test_type: 1, is_active: 1 });
scorecardTestSchema.index({ name: "text", description: "text" });

const ScorecardTest = mongoose.model("ScorecardTest", scorecardTestSchema);
ScorecardTest.SCORECARD_TEST_TYPES = TEST_TYPES;
module.exports = ScorecardTest;
