const mongoose = require("mongoose");

const codeBlockSchema = new mongoose.Schema(
  {
    lang: { type: String, default: "text" },
    content: { type: String, default: "" },
  },
  { _id: false }
);

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    mime_type: { type: String, default: "" },
    file_name: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    kind: { type: String, enum: ["image", "video", "file"], default: "file" },
  },
  { _id: false }
);

const communityMessageSchema = new mongoose.Schema(
  {
    channel_id: { type: String, required: true, trim: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", default: null, index: true },
    staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    author_role: { type: String, enum: ["student", "instructor", "mentor", "admin", "super_admin"], default: "student" },
    author_name: { type: String, default: "" },
    text: { type: String, default: "" },
    code: { type: codeBlockSchema, default: undefined },
    media: { type: mediaSchema, default: undefined },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Student" }],
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("CommunityMessage", communityMessageSchema);
