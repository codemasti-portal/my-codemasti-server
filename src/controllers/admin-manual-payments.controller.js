// Admin review of student-submitted UPI payment proofs (manual_upi flow).
//   GET   /admin/manual-payments              → list (filter by status/student)
//   PATCH /admin/manual-payments/:id          → update review_note (approved/rejected only)
//   POST  /admin/manual-payments/:id/approve  → verify + mark invoice paid + write Payment row
//   POST  /admin/manual-payments/:id/reject   → reject with a reason
//
// A screenshot is never trusted on its own. Approval is a deliberate human action: the reviewer
// confirms the money actually landed in the UPI/bank account, THEN approves here.

const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const ManualPayment = require("../models/ManualPayment");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");

function manualRowOut(m, populated = {}) {
  return {
    id: String(m._id),
    invoice_id: String(m.invoice_id),
    student_id: String(m.student_id),
    amount_paise: m.amount_paise,
    payee_vpa: m.payee_vpa || "",
    utr_reference: m.utr_reference || "",
    screenshot_url: m.screenshot_url,
    status: m.status,
    review_note: m.review_note || "",
    reviewed_at: m.reviewed_at,
    payment_id: m.payment_id ? String(m.payment_id) : null,
    created_at: m.createdAt,
    student: populated.student
      ? { id: String(populated.student._id), name: populated.student.name, email: populated.student.email }
      : null,
    invoice: populated.invoice
      ? {
          id: String(populated.invoice._id),
          invoice_number: populated.invoice.invoice_number,
          status: populated.invoice.status,
          total_due_paise: populated.invoice.total_due_paise,
        }
      : null,
  };
}

/** GET /admin/billing/manual-payments */
async function listManualPayments(req, res) {
  const schema = z.object({
    status: z.enum(["submitted", "approved", "rejected"]).optional(),
    student_id: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid query");
  const q = parsed.data;

  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.student_id && mongoose.Types.ObjectId.isValid(q.student_id)) filter.student_id = q.student_id;

  const page = q.page || 1;
  const limit = q.limit || 50;
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    ManualPayment.countDocuments(filter),
    ManualPayment.find(filter)
      .populate({ path: "student_id", select: "name email" })
      .populate({ path: "invoice_id", select: "invoice_number status total_due_paise" })
      // Pending reviews first, then newest.
      .sort({ status: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  return sendSuccess(
    res,
    rows.map((m) => manualRowOut(m, { student: m.student_id, invoice: m.invoice_id })),
    "",
    { page, limit, total }
  );
}

/** POST /admin/billing/manual-payments/:id/approve */
async function approveManualPayment(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");

  const body = z
    .object({ note: z.string().trim().max(500).optional() })
    .safeParse(req.body || {});
  const note = body.success ? body.data.note || "" : "";

  const mp = await ManualPayment.findById(id);
  if (!mp) return sendError(res, 404, "NOT_FOUND", "Manual payment not found");
  if (mp.status !== "submitted") {
    return sendError(res, 409, "ALREADY_REVIEWED", `This proof is already ${mp.status}`);
  }

  const invoice = await Invoice.findById(mp.invoice_id);
  if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");
  if (invoice.status !== "pending") {
    return sendError(res, 409, "INVOICE_NOT_PAYABLE", `Invoice is ${invoice.status}`);
  }

  // Write a real Payment row so admin Payments + reconciliation include manual UPI receipts.
  const payment = await Payment.create({
    invoice_id: invoice._id,
    student_id: mp.student_id,
    amount_paise: mp.amount_paise,
    merchant_transaction_id: `MANUAL-${mp._id}`,
    status: "success",
    payment_method: "UPI",
    completed_at: new Date(),
  });

  invoice.status = "paid";
  invoice.paid_at = new Date();
  invoice.paid_payment_id = payment._id;
  await invoice.save();

  mp.status = "approved";
  mp.review_note = note;
  mp.reviewed_by_staff_id = req.staff?.sub || null;
  mp.reviewed_at = new Date();
  mp.payment_id = payment._id;
  await mp.save();

  return sendSuccess(res, manualRowOut(mp), "Payment approved and invoice marked paid");
}

/** POST /admin/billing/manual-payments/:id/reject */
async function rejectManualPayment(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");

  const body = z
    .object({ note: z.string().trim().max(500).optional() })
    .safeParse(req.body || {});
  const note = body.success ? body.data.note || "" : "";

  const mp = await ManualPayment.findById(id);
  if (!mp) return sendError(res, 404, "NOT_FOUND", "Manual payment not found");
  if (mp.status !== "submitted") {
    return sendError(res, 409, "ALREADY_REVIEWED", `This proof is already ${mp.status}`);
  }

  mp.status = "rejected";
  mp.review_note = note;
  mp.reviewed_by_staff_id = req.staff?.sub || null;
  mp.reviewed_at = new Date();
  await mp.save();

  return sendSuccess(res, manualRowOut(mp), "Payment proof rejected");
}

/** PATCH /admin/manual-payments/:id — update review note after approve/reject */
async function patchManualPaymentNote(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");

  const body = z
    .object({ review_note: z.string().trim().max(500) })
    .safeParse(req.body || {});
  if (!body.success) {
    return sendError(res, 400, "VALIDATION_ERROR", body.error.issues[0]?.message || "Invalid body");
  }

  const mp = await ManualPayment.findById(id);
  if (!mp) return sendError(res, 404, "NOT_FOUND", "Manual payment not found");
  if (mp.status === "submitted") {
    return sendError(
      res,
      409,
      "NOT_REVIEWED",
      "Use approve or reject while the payment is under review. Notes can be edited after that."
    );
  }

  mp.review_note = body.data.review_note;
  await mp.save();

  const populated = await ManualPayment.findById(mp._id)
    .populate({ path: "student_id", select: "name email" })
    .populate({ path: "invoice_id", select: "invoice_number status total_due_paise" })
    .lean();

  return sendSuccess(
    res,
    manualRowOut(populated, { student: populated.student_id, invoice: populated.invoice_id }),
    "Review note updated"
  );
}

module.exports = {
  listManualPayments,
  approveManualPayment,
  rejectManualPayment,
  patchManualPaymentNote,
};
