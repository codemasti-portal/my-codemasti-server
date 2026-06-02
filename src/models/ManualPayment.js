const mongoose = require("mongoose");

// A student-submitted "I paid via UPI" claim, awaiting staff verification.
// IMPORTANT: a screenshot proves nothing on its own — it is trivially faked. An invoice is only
// marked paid when a super_admin verifies the money actually landed and APPROVES the claim. On
// approval we also write a real Payment row (method UPI) so the money ledger stays consistent.
const MANUAL_PAYMENT_STATUSES = ["submitted", "approved", "rejected"];

const manualPaymentSchema = new mongoose.Schema(
  {
    invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },

    // Snapshot of what was due when the student submitted (the invoice can change later).
    amount_paise: { type: Number, required: true, min: 0 },

    // Payee VPA the student was shown at submission time (for audit / if it ever changes).
    payee_vpa: { type: String, default: "", trim: true, maxlength: 120 },
    // Optional UPI reference / UTR the student typed in. Helps the reviewer match the bank credit.
    utr_reference: { type: String, default: "", trim: true, maxlength: 64 },

    screenshot_url: { type: String, required: true, trim: true },
    screenshot_public_id: { type: String, default: "", trim: true },

    status: { type: String, enum: MANUAL_PAYMENT_STATUSES, default: "submitted", index: true },

    // Set on approve/reject.
    review_note: { type: String, default: "", trim: true, maxlength: 500 },
    reviewed_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    reviewed_at: { type: Date, default: null },

    // The Payment row created when this claim is approved (links the ledger).
    payment_id: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
  },
  { timestamps: true, versionKey: false }
);

manualPaymentSchema.index({ status: 1, createdAt: -1 });
manualPaymentSchema.index({ invoice_id: 1, createdAt: -1 });

module.exports = mongoose.model("ManualPayment", manualPaymentSchema);
module.exports.MANUAL_PAYMENT_STATUSES = MANUAL_PAYMENT_STATUSES;
