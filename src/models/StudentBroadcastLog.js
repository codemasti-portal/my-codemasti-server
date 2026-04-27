const mongoose = require("mongoose");

/** One row per “notify all students” send (audit + admin log). */
const studentBroadcastLogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    recipient_count: { type: Number, required: true, min: 0 },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

studentBroadcastLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("StudentBroadcastLog", studentBroadcastLogSchema);
