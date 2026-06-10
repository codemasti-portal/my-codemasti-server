const mongoose = require("mongoose");

const ASSIGNMENT_TYPES = ["quiz", "coding", "written", "project", "other"];

const assignmentSchema = new mongoose.Schema(
  {
    /** Catalog batch (e.g. spark, builders); lowercase. Empty = legacy / visible to all batches. */
    batch_id: { type: String, default: "", trim: true, index: true },
    /** Optional multi-batch tagging (same convention as arena); use with batch_id for queries. */
    batch_ids: { type: [{ type: String, trim: true }], default: [] },
    /** Empty means assignment is released to all sections in the selected batch. */
    section_id: { type: String, default: "", trim: true, index: true },
    /** Assignment title (e.g. "Variables & Data Types") */
    title: { type: String, default: "", trim: true },
    subject: { type: String, required: true, trim: true, index: true },
    module: { type: String, required: true, trim: true, index: true },
    assignment_type: {
      type: String,
      enum: ASSIGNMENT_TYPES,
      default: "written",
      trim: true,
      index: true,
    },
    /** For coding assignments: python or javascript only. */
    programming_language: {
      type: String,
      enum: ["python", "javascript"],
      default: "python",
      trim: true,
    },
    release_date: { type: Date, required: true, index: true },
    deadline_date: { type: Date, required: true, index: true },
    /** Set when students received the “New assignment” in-app notify (immediate or via scheduler); prevents duplicates. */
    release_notification_sent_at: { type: Date, default: null, index: true },
    /** Optional PDF / image / external link (e.g. handout, brief) — same pattern as notes. */
    resource_url: { type: String, default: "", trim: true },
    resource_size: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Assignment", assignmentSchema);
