const mongoose = require("mongoose");

const classJoinAuditSchema = new mongoose.Schema(
  {
    class_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LiveClass",
      required: true,
      index: true,
    },
    student_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    // Batch the student attended this class AS (the class's batch, or their matching batch for a
    // multi-target class). Stamped at join time so per-batch attendance is accurate under M:N.
    batch_id: { type: String, default: "", lowercase: true, trim: true, index: true },
    joined_at: { type: Date, default: Date.now, index: true },
    source: { type: String, default: "web", trim: true },
    ip_address: { type: String, default: "" },
    user_agent: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false }
);

classJoinAuditSchema.index({ class_id: 1, student_id: 1, joined_at: -1 });

module.exports = mongoose.model("ClassJoinAudit", classJoinAuditSchema);
