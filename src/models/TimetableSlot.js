const mongoose = require("mongoose");

const timetableSlotSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, trim: true, index: true },
    /** Empty = applies to all sections in the batch; otherwise catalog section_id (e.g. core). */
    section_id: { type: String, default: "", trim: true, index: true },
    day: {
      type: String,
      required: true,
      enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      index: true,
    },
    /** Optional exact class date (YYYY-MM-DD) for calendar-based scheduling. */
    class_date: { type: String, default: "", trim: true, index: true },
    time: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true, index: true },
    teacher: { type: String, required: true, trim: true },
    meet_link: { type: String, default: "", trim: true },
    is_taken: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("TimetableSlot", timetableSlotSchema);
