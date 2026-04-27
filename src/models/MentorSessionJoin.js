const mongoose = require("mongoose");

const mentorSessionJoinSchema = new mongoose.Schema(
  {
    slot_id: { type: mongoose.Schema.Types.ObjectId, ref: "MentorSlot", required: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    joined_at: { type: Date, default: Date.now },
    source: { type: String, default: "web" },
  },
  { timestamps: true, versionKey: false }
);

mentorSessionJoinSchema.index({ slot_id: 1, student_id: 1 }, { unique: true });

module.exports = mongoose.model("MentorSessionJoin", mentorSessionJoinSchema);
