const mongoose = require("mongoose");

const ASSIGNMENT_TYPES = ["quiz", "coding", "written", "project", "other"];

const assignmentSchema = new mongoose.Schema(
  {
    /** Catalog batch (e.g. spark, builders); lowercase. Empty = legacy / visible to all batches. */
    batch_id: { type: String, default: "", trim: true, index: true },
    /** Empty means assignment is released to all sections in the selected batch. */
    section_id: { type: String, default: "", trim: true, index: true },
    subject: { type: String, required: true, trim: true, index: true },
    module: { type: String, required: true, trim: true, index: true },
    assignment_type: {
      type: String,
      enum: ASSIGNMENT_TYPES,
      default: "written",
      trim: true,
      index: true,
    },
    release_date: { type: Date, required: true, index: true },
    deadline_date: { type: Date, required: true, index: true },
    /** Optional PDF / image / external link (e.g. handout, brief) — same pattern as notes. */
    resource_url: { type: String, default: "", trim: true },
    resource_size: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Assignment", assignmentSchema);
