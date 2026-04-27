const mongoose = require("mongoose");

const supportConversationSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    admin_status: { type: String, enum: ["pending", "ongoing", "resolved"], default: "pending" },
    admin_status_updated_at: { type: Date, default: Date.now },
    last_message_at: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

supportConversationSchema.index({ student_id: 1, status: 1 });

module.exports = mongoose.model("SupportConversation", supportConversationSchema);
