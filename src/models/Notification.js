const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    type: { type: String, enum: ["announcement", "system"], default: "system", index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: "" },
    read_at: { type: Date, default: null, index: true },
    ref_id: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Notification", notificationSchema);
