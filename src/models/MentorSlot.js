const mongoose = require("mongoose");

const mentorSlotSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    mentor_name: { type: String, required: true, trim: true },
    mentor_info: { type: String, default: "", trim: true },
    date: { type: Date, required: true, index: true },
    publish_date: { type: Date, default: Date.now, index: true },
    time: { type: String, required: true },
    duration_minutes: { type: Number, default: 60, min: 1 },
    meet_link: { type: String, default: "" },
    reminder_15m_sent_at: { type: Date, default: null, index: true },
    meet_link_missing_alert_15m_sent_at: { type: Date, default: null, index: true },
    target_batch_ids: [{ type: String, trim: true, lowercase: true }],
    target_section_ids: [{ type: String, trim: true, lowercase: true }],
    target_student_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
    booking_state: { type: String, enum: ["open", "booked", "cancelled"], default: "open", index: true },
    booked_by: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
    booked_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("MentorSlot", mentorSlotSchema);
