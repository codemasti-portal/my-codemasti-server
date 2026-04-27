const mongoose = require("mongoose");

const supportMessageSchema = new mongoose.Schema(
  {
    conversation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupportConversation",
      required: true,
      index: true,
    },
    from: { type: String, enum: ["student", "agent"], required: true },
    text: { type: String, required: true },
    admin_status: { type: String, enum: ["pending", "ongoing", "resolved"], default: "pending" },
    admin_status_updated_at: { type: Date, default: Date.now },
    media: {
      url: { type: String, default: "" },
      mime_type: { type: String, default: "" },
      file_name: { type: String, default: "" },
      bytes: { type: Number, default: 0 },
      kind: { type: String, enum: ["image", "video", "file"], default: "file" },
    },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("SupportMessage", supportMessageSchema);
