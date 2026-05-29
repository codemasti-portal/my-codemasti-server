const mongoose = require("mongoose");

const INVOICE_STATUSES = ["pending", "paid", "failed", "refunded", "partially_refunded", "cancelled"];

const invoiceSchema = new mongoose.Schema(
  {
    invoice_number: { type: String, required: true, unique: true, trim: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    enrollment_id: { type: mongoose.Schema.Types.ObjectId, ref: "StudentEnrollment", required: true, index: true },
    course_id: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },

    period_label: { type: String, default: "", trim: true, maxlength: 80 },
    period_start: { type: Date, default: null },
    period_end: { type: Date, default: null },

    subtotal_paise: { type: Number, required: true, min: 0 },
    scholarship_discount_paise: { type: Number, default: 0, min: 0 },
    referral_discount_paise: { type: Number, default: 0, min: 0 },
    registration_discount_paise: { type: Number, default: 0, min: 0 },
    manual_adjustment_paise: { type: Number, default: 0 },
    manual_adjustment_reason: { type: String, default: "", trim: true, maxlength: 500 },
    total_due_paise: { type: Number, required: true, min: 0 },

    status: { type: String, enum: INVOICE_STATUSES, default: "pending", index: true },
    due_date: { type: Date, default: null },
    paid_at: { type: Date, default: null },
    paid_payment_id: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
    refunded_paise: { type: Number, default: 0, min: 0 },

    generated_by: { type: String, default: "system", trim: true },
    generated_by_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    reminder_pre_due_sent_at: { type: Date, default: null },
    reminder_overdue_sent_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

invoiceSchema.index({ student_id: 1, status: 1, due_date: 1 });
invoiceSchema.index({ enrollment_id: 1, status: 1 });

module.exports = mongoose.model("Invoice", invoiceSchema);
module.exports.INVOICE_STATUSES = INVOICE_STATUSES;
