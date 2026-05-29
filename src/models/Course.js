const mongoose = require("mongoose");

const COURSE_CATEGORIES = ["specialization", "workshop", "bootcamp", "masterclass", "other"];
const BILLING_MODES = ["monthly", "upfront"];

const courseSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: COURSE_CATEGORIES, default: "specialization", index: true },
    description: { type: String, default: "", trim: true, maxlength: 4000 },
    duration_months: { type: Number, default: null, min: 0, max: 120 },
    billing_mode: { type: String, enum: BILLING_MODES, default: "monthly" },
    base_fee_paise: { type: Number, required: true, min: 0 },
    starts_on: { type: Date, default: null },
    ends_on: { type: Date, default: null },
    is_active: { type: Boolean, default: true, index: true },
    /** Optional FK → BatchCatalog.batch_id (e.g. "spark"); lets legacy batch-scoped features keep working. */
    linked_batch_id: { type: String, default: "", trim: true, lowercase: true, index: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

courseSchema.index({ category: 1, is_active: 1, name: 1 });

module.exports = mongoose.model("Course", courseSchema);
module.exports.COURSE_CATEGORIES = COURSE_CATEGORIES;
module.exports.BILLING_MODES = BILLING_MODES;
