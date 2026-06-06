const mongoose = require("mongoose");

const sectionSchema = new mongoose.Schema(
  {
    section_id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    subjects: { type: [String], default: [] },
  },
  { _id: false }
);

const batchCatalogSchema = new mongoose.Schema(
  {
    batch_id: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    sections: { type: [sectionSchema], default: [] },

    // --- Data-driven replacements for hardcoded batch maps (Phase 0; all additive & defaulted) ---
    /** Enrollment-number letter for this batch (e.g. "S"/"B"/"I"). Empty = batch has no enrollment-number identity. */
    enrollment_prefix: { type: String, default: "", uppercase: true, trim: true, maxlength: 2 },
    /** Human tier label (e.g. Beginner/Intermediate/Advanced). Display only. */
    tier_label: { type: String, default: "", trim: true },
    /** Seeded/system batch that must not be deleted (Spark, Builders, Innovators). */
    is_protected: { type: Boolean, default: false },
    /** Soft-retire flag — retired batches are hidden from lists but never deleted. */
    is_active: { type: Boolean, default: true, index: true },
    /** Included in "all default batches" views (e.g. staff doubts community). */
    include_in_default_views: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false }
);

// One enrollment_prefix maps to at most one batch (preserves the I/S/B letter semantics, now dynamic).
// Partial so the many rows with empty prefix don't collide.
batchCatalogSchema.index(
  { enrollment_prefix: 1 },
  { unique: true, partialFilterExpression: { enrollment_prefix: { $type: "string", $ne: "" } } }
);

module.exports = mongoose.model("BatchCatalog", batchCatalogSchema);
