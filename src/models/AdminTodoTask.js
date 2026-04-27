const mongoose = require("mongoose");

const adminTodoTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", trim: true, maxlength: 4000 },
    status: { type: String, enum: ["pending", "in_progress", "resolved"], default: "pending", index: true },
    resolved_at: { type: Date, default: null },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true, index: true },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true, versionKey: false }
);

adminTodoTaskSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("AdminTodoTask", adminTodoTaskSchema);
