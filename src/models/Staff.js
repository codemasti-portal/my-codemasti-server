const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** Optional bcrypt hash for manual DB setup / future password flows; login is OTP-based. */
    password_hash: { type: String, default: "" },
    role: {
      type: String,
      enum: ["super_admin", "admin", "instructor", "mentor"],
      required: true,
    },
    phone_number: { type: String, default: "", trim: true },
    profile_image_url: { type: String, default: "" },
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
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("Staff", staffSchema);
