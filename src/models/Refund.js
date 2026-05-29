const mongoose = require("mongoose");

const REFUND_STATUSES = ["initiated", "pending", "success", "failed"];

const refundSchema = new mongoose.Schema(
  {
    payment_id: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, index: true },
    invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    amount_paise: { type: Number, required: true, min: 0 },
    reason: { type: String, default: "", trim: true, maxlength: 500 },
    status: { type: String, enum: REFUND_STATUSES, default: "initiated", index: true },
    merchant_refund_id: { type: String, required: true, unique: true, trim: true },
    phonepe_refund_id: { type: String, default: "", trim: true },
    webhook_payload: { type: mongoose.Schema.Types.Mixed, default: null },
    webhook_received_at: { type: Date, default: null },
    initiated_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    completed_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

refundSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Refund", refundSchema);
module.exports.REFUND_STATUSES = REFUND_STATUSES;
