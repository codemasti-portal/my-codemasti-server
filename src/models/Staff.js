const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** Optional bcrypt hash for manual DB setup / future password flows; login is OTP-based. */
    password_hash: { type: String, default: "" },
    /** True only after staff completes user-facing password setup/reset/update. */
    password_set_by_user: { type: Boolean, default: false },
    role: {
      type: String,
      enum: ["super_admin", "admin", "instructor", "mentor"],
      required: true,
    },
    phone_number: { type: String, default: "", trim: true },
    profile_image_url: { type: String, default: "" },
    last_login_at: { type: Date, default: null },
    last_login_ip: { type: String, default: "", trim: true },
    last_login_user_agent: { type: String, default: "", trim: true },
    bio: { type: String, default: "", trim: true },
    experience_years: { type: Number, default: 0, min: 0, max: 60 },
    resume_url: { type: String, default: "" },
    account_status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
    },
    subjects_teaching: { type: [String], default: [] },
    batches_assigned: { type: [String], default: [] },
    experience_level: { type: String, default: "", trim: true },
    assigned_students: { type: [String], default: [] },
    expertise_area: { type: String, default: "", trim: true },
    availability: { type: String, default: "", trim: true },
    profile_completion_score: { type: Number, default: 0, min: 0, max: 100 },
    is_profile_complete: { type: Boolean, default: false },
    admin_notes: { type: String, default: "", trim: true },
    last_updated_by_admin: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    is_active: { type: Boolean, default: true },
    /**
     * When true, this admin/super_admin receives operational scheduling alerts (e.g. missing Meet link).
     * Only meaningful for admin/super_admin roles; defaults false for all staff.
     */
    receives_scheduling_alerts: { type: Boolean, default: false },
    /** Bumped on logout, password change, or being disabled — invalidates every token issued
     * before the bump (embedded as the `tv` claim), so those actions take effect immediately
     * instead of waiting out the token's natural expiry. */
    token_version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Staff", staffSchema);
