const mongoose = require("mongoose");

const staffOtpRequestSchema = new mongoose.Schema(
  {
    otp_request_id: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    otp: { type: String, required: true },
    expires_at: { type: Date, required: true, index: true },
    used_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("StaffOtpRequest", staffOtpRequestSchema);
