const mongoose = require("mongoose");

const EVENT_TYPES = ["holiday", "workshop", "masterclass", "hackathon", "other"];

const timetableEventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: EVENT_TYPES,
      index: true,
    },
    description: { type: String, default: "", trim: true },
    date: { type: Date, required: true, index: true },
    batch_id: { type: String, default: "", trim: true, index: true },
    /** Empty = applies to all sections in the batch (mirrors TimetableSlot.section_id). */
    section_id: { type: String, default: "", trim: true, index: true },

    /** Holidays are always all-day; other categories can opt into a specific time. */
    all_day: { type: Boolean, default: true },
    /** Start time as "HH:mm" (24h), only meaningful when all_day is false. */
    time: { type: String, default: "", trim: true },
    duration_minutes: { type: Number, default: 60, min: 1 },
    meet_link: { type: String, default: "", trim: true },

    /** One-time "starts in ~15 minutes" reminder for timed events with a Meet link. */
    reminder_15m_sent_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

const TimetableEvent = mongoose.model("TimetableEvent", timetableEventSchema);
TimetableEvent.EVENT_TYPES = EVENT_TYPES;

module.exports = TimetableEvent;
