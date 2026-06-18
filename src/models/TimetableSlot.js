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
    /** Exact class date (YYYY-MM-DD). */
    class_date: { type: String, required: true, trim: true, index: true },
    time: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true, index: true },
    topic: { type: String, default: "", trim: true },
    teacher: { type: String, required: true, trim: true },
    /** Optional reference to the Staff document. When set, instructor notifications use ID-based lookup (more reliable than name matching). */
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    meet_link: { type: String, default: "", trim: true },
    recording_link: { type: String, default: "", trim: true },
    notes_link: { type: String, default: "", trim: true },
    is_taken: { type: Boolean, default: false, index: true },

    /** One-time “class starts in ~10 minutes” reminders (prevent duplicate emails on each poll tick). */
    student_reminder_10m_sent_at: { type: Date, default: null },
    instructor_reminder_10m_sent_at: { type: Date, default: null },

    /** One-time "class is now live" notification sent at the scheduled start time. */
    class_live_sent_at: { type: Date, default: null },

    /** One-time alert when meet_link is missing near start time. */
    meet_link_missing_10m_alert_sent_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("TimetableSlot", timetableSlotSchema);
