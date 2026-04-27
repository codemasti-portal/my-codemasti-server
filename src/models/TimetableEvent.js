const mongoose = require("mongoose");

const timetableEventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ["holiday", "workshop", "mentor", "event"],
      index: true,
    },
    description: { type: String, default: "", trim: true },
    date: { type: Date, required: true, index: true },
    batch_id: { type: String, default: "", trim: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("TimetableEvent", timetableEventSchema);
