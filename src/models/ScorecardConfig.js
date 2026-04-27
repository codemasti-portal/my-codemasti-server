const mongoose = require("mongoose");

const scholarshipRuleSchema = new mongoose.Schema(
  {
    min_percent: { type: Number, required: true, min: 0, max: 100 },
    scholarship_percent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

const scorecardConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    test_names: { type: [String], default: ["Monthly Test 1", "Monthly Test 2", "Phase Test", "Grand Test"] },
    scholarship_rules: {
      type: [scholarshipRuleSchema],
      default: [
        { min_percent: 90, scholarship_percent: 20 },
        { min_percent: 80, scholarship_percent: 10 },
        { min_percent: 70, scholarship_percent: 5 },
      ],
    },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("ScorecardConfig", scorecardConfigSchema);

