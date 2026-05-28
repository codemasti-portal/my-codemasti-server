const mongoose = require("mongoose");

const PAYMENT_STATUSES = ["initiated", "pending", "success", "failed", "refunded", "partially_refunded"];
const PAYMENT_METHODS = ["UPI", "CARD", "NETBANKING", "WALLET", "OTHER"];

const paymentSchema = new mongoose.Schema(
  {
    invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    amount_paise: { type: Number, required: true, min: 0 },

    merchant_transaction_id: { type: String, required: true, unique: true, trim: true },
    phonepe_transaction_id: { type: String, default: "", trim: true, index: true },

    status: { type: String, enum: PAYMENT_STATUSES, default: "initiated", index: true },
    payment_method: { type: String, enum: PAYMENT_METHODS, default: "OTHER" },
    failure_code: { type: String, default: "", trim: true },
    failure_reason: { type: String, default: "", trim: true, maxlength: 500 },

    webhook_payload: { type: mongoose.Schema.Types.Mixed, default: null },
    webhook_received_at: { type: Date, default: null },

    refunded_paise: { type: Number, default: 0, min: 0 },

    initiated_at: { type: Date, default: Date.now },
    completed_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ student_id: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
