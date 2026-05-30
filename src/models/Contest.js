const mongoose = require("mongoose");

const contestSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    /** Shared scorecard test definition (one test, many batch contests). */
    test_id: { type: mongoose.Schema.Types.ObjectId, ref: "ScorecardTest", required: true, index: true },
    /** Exactly one catalog batch per contest row. */
    batch_id: { type: String, required: true, lowercase: true, trim: true, index: true },
    /** Empty = all sections in the batch. */
    section_ids: { type: [String], default: [] },

    /** When students first see this contest on the portal. */
    show_from: { type: Date, required: true, index: true },
    /** When the external contest platform opens. */
    start_at: { type: Date, required: true, index: true },
    end_at: { type: Date, required: true, index: true },

    platform_url: { type: String, required: true, trim: true, maxlength: 2000 },
    results_url: { type: String, default: "", trim: true, maxlength: 2000 },
    results_until: { type: Date, default: null },

    /** Groups multi-batch schedules created together in admin. */
    event_group_id: { type: String, default: "", trim: true, index: true },

    is_published: { type: Boolean, default: false, index: true },
    published_at: { type: Date, default: null },

    created_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    updated_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

contestSchema.index({ batch_id: 1, show_from: -1 });
contestSchema.index({ test_id: 1, batch_id: 1 });

module.exports = mongoose.model("Contest", contestSchema);
