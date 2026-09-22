const mongoose = require("mongoose");

const ASSIGNMENT_TYPES = ["quiz", "coding", "written", "web", "project", "other"];

const assignmentSchema = new mongoose.Schema(
  {
    /** Catalog batch (e.g. spark, builders); lowercase. Empty = legacy / visible to all batches. */
    batch_id: { type: String, default: "", trim: true, index: true },
    /** Optional multi-batch tagging (same convention as arena); use with batch_id for queries. */
    batch_ids: { type: [{ type: String, trim: true }], default: [] },
    /** Empty means assignment is released to all sections in the selected batch (legacy single-section). */
    section_id: { type: String, default: "", trim: true, index: true },
    /**
     * Canonical section targeting for this batch-scoped assignment row.
     * Empty array (+ empty section_id) = all sections in the batch.
     * Non-empty = only these catalog section_ids. Never interpret unknown ids as all-sections.
     */
    section_ids: { type: [{ type: String, trim: true, lowercase: true }], default: [] },
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
    /**
     * Instructor-evaluation ceiling for Project assignments.
     * Unused by quiz/coding/written/web. 0 means evaluation is blocked until configured.
     */
    project_max_marks: { type: Number, default: 100, min: 0, max: 1000 },
    /**
     * Project-only publication. false = draft (students cannot see it).
     * true = published (still gated by release_date).
     * Unset on historical rows — student access then requires a complete document.
     * Never used for quiz/coding/written/web.
     */
    project_published: { type: Boolean },
    /**
     * Optional client token so a retried multi-batch Project create does not duplicate headers.
     * Empty on legacy / non-Project rows. Non-empty values are unique per batch for Projects
     * via uniq_project_creation_group_batch (partial unique index).
     */
    creation_group_id: { type: String, default: "", trim: true, index: true },
  },
  { timestamps: true, versionKey: false }
);

/**
 * One Project header per (creation_group_id, batch_id) when the group id is non-empty.
 * Legacy rows with creation_group_id "" are excluded so they can coexist.
 * Non-Project assignments are excluded so quiz/coding/written/web are unaffected.
 *
 * Deploy: verify no duplicate (creation_group_id, batch_id) pairs among Project rows
 * with a non-empty creation_group_id before building this index in a shared database.
 * Do not silently delete duplicates. This process does not run createIndex against
 * production/shared databases.
 */
assignmentSchema.index(
  { creation_group_id: 1, batch_id: 1 },
  {
    unique: true,
    name: "uniq_project_creation_group_batch",
    partialFilterExpression: {
      assignment_type: "project",
      creation_group_id: { $gt: "" },
    },
  }
);

module.exports = mongoose.model("Assignment", assignmentSchema);
