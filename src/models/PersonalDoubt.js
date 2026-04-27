const mongoose = require("mongoose");

const personalDoubtSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    subject: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    code: { type: String, default: "" },
    image_url: { type: String, default: "" },
    status: { type: String, enum: ["pending", "answered"], default: "pending", index: true },
    teacher_name: { type: String, default: "" },
    teacher_reply: { type: String, default: "" },
    teacher_reply_code: { type: String, default: "" },
    teacher_reply_image_url: { type: String, default: "" },
    answered_at: { type: Date, default: null },
    unread_by_student: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("PersonalDoubt", personalDoubtSchema);
