const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: {
      type: String,
      enum: ["student", "mentor", "teacher", "admin"],
      default: "student",
    },
    // "batch" is the display label used by announcements/etc.
    batch: { type: String, default: "" },
    // "batch_id" is the identifier used by timetable/live classes APIs.
    batch_id: { type: String, default: "" },
    /** Catalog section id (e.g. "core") for notes targeting; optional. */
    section_id: { type: String, default: "", trim: true },
    course: { type: String, default: "" },
    avatar_url: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    parent_name: { type: String, default: "" },
    /** Parent / guardian contact (admin UI: parent contact number). */
    phone_number: { type: String, default: "" },
    student_phone: { type: String, default: "", trim: true },
    whatsapp_number: { type: String, default: "", trim: true },
    school_name: { type: String, default: "", trim: true },
    cst_registration_id: { type: String, default: "", trim: true },
    /** School grade / class; admin form allows 5–10. */
    school_class: { type: Number, default: null },
    // Format: I260105 = Innovators, 2026, section 01, roll 05 (I|S|B + YY + SS + RR)
    // Keep it unset by default so the unique sparse index won't collide.
    enrollment_number: { type: String, default: undefined, trim: true },
    enrollment_batch_prefix: { type: String, default: "", trim: true },
    enrollment_batch_name: { type: String, default: "", trim: true },
    enrollment_year: { type: Number, default: 0 },
    enrollment_section: { type: String, default: "" },
    enrollment_roll_no: { type: String, default: "" },
    batch_allowance: { type: String, default: "" },
    enrollment_date: { type: Date, default: Date.now },
    /** Optional bcrypt hash for password change flow; OTP remains primary login. */
    password_hash: { type: String, default: "" },
    /** True only after student completes user-facing password setup/reset/update. */
    password_set_by_user: { type: Boolean, default: false },
    referral_code: { type: String, trim: true, sparse: true, index: true },
    /** Added to verified referral count for display / student portal (offline or corrected referrals). */
    referral_bonus_count: { type: Number, default: 0, min: 0, max: 500 },
    referred_by: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
    /** One-time registration fee discount for referee (e.g. 10% with valid referral). */
    registration_fee_discount_percent: { type: Number, default: 0, min: 0, max: 100 },
    /**
     * Pending refer & earn rewards: fee credits (percent × months) and non-fee items (e.g. merchandise).
     */
    referral_benefits_queue: {
      type: [
        {
          kind: { type: String, required: true, trim: true },
          label: { type: String, default: "", trim: true },
          monthly_fee_discount_percent: { type: Number, required: true, min: 0, max: 100 },
          /** Fee credits: 1–36; merchandise / non-fee: 0 */
          months: { type: Number, default: 1, min: 0, max: 36 },
          from_student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null },
          granted_at: { type: Date, default: Date.now },
          /** auto = system referral; manual_admin = staff adjustment */
          source: { type: String, enum: ["auto", "manual_admin"], default: "auto" },
          reward_type: { type: String, enum: ["fee_credit", "merchandise"], default: "fee_credit" },
        },
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false }
);

// Prevent duplicates only when enrollment_number is provided.
studentSchema.index({ enrollment_number: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Student", studentSchema);
