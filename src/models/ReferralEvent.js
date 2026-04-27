const mongoose = require("mongoose");

const referralEventSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    event: { type: String, required: true, trim: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("ReferralEvent", referralEventSchema);
