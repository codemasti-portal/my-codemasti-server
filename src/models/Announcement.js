const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    scope: { type: String, enum: ["batch", "global"], default: "global", index: true },
    /** Display batch label (matches Student.batch). */
    batch: { type: String, default: "", index: true },
    /** Catalog batch id when set (matches Student.batch_id). */
    batch_id: { type: String, default: "", index: true },
    /**
     * Normalized section ids; empty array = all sections in that program.
     * Non-empty = only students in those sections (section_id or enrollment_section).
     */
    section_ids: { type: [String], default: [] },
    /** Shown on cards; students only see the announcement when `date <= now` (schedule future values). */
    date: { type: Date, default: Date.now, index: true },
    created_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    created_by_name: { type: String, default: "", trim: true },
    created_by_role: { type: String, default: "", trim: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Announcement", announcementSchema);
