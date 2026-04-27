const mongoose = require("mongoose");

const sectionRefSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, trim: true },
    section_id: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const liveClassSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, index: true },
    topic: { type: String, required: true, trim: true },
    instructor: { type: String, required: true, trim: true },
    // Legacy single-target batch id (kept for backward compatibility).
    batch_id: { type: String, default: "", trim: true, index: true },
    /** Which batch ids this class applies to (multi-target). */
    target_batch_ids: { type: [String], default: [] },
    /** Which batch+section pairs this class applies to (multi-target). */
    target_section_refs: { type: [sectionRefSchema], default: [] },
    date: { type: String, required: true, trim: true, index: true }, // YYYY-MM-DD
    start_time: { type: String, required: true, trim: true }, // HH:mm
    end_time: { type: String, required: true, trim: true }, // HH:mm
    meet_link: { type: String, required: true, trim: true },
    recording_link: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("LiveClass", liveClassSchema);
