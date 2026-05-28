const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const Refund = require("../models/Refund");
const phonepe = require("../services/phonepe-gateway.service");

const PERIOD_RE = /^\d{4}-\d{2}$/;

function paymentOut(p, populated = {}) {
  return {
    id: String(p._id),
    invoice_id: String(p.invoice_id),
    student_id: String(p.student_id),
    amount_paise: p.amount_paise,
    merchant_transaction_id: p.merchant_transaction_id,
    phonepe_transaction_id: p.phonepe_transaction_id || "",
    status: p.status,
    payment_method: p.payment_method,
    failure_code: p.failure_code || "",
    failure_reason: p.failure_reason || "",
    refunded_paise: p.refunded_paise || 0,
    initiated_at: p.initiated_at,
    completed_at: p.completed_at,
    webhook_received_at: p.webhook_received_at,
    created_at: p.createdAt,
    student: populated.student
      ? { id: String(populated.student._id), name: populated.student.name, email: populated.student.email }
      : null,
    invoice: populated.invoice
      ? { id: String(populated.invoice._id), invoice_number: populated.invoice.invoice_number, status: populated.invoice.status }
      : null,
  };
}

function refundOut(r) {
  return {
    id: String(r._id),
    payment_id: String(r.payment_id),
    invoice_id: String(r.invoice_id),
    student_id: String(r.student_id),
    amount_paise: r.amount_paise,
    reason: r.reason || "",
    status: r.status,
    merchant_refund_id: r.merchant_refund_id,
    phonepe_refund_id: r.phonepe_refund_id || "",
    initiated_at: r.createdAt,
    completed_at: r.completed_at,
  };
}

async function listPayments(req, res) {
  const schema = z.object({
    student_id: z.string().optional(),
    status: z.string().optional(),
    period: z.string().regex(PERIOD_RE).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid query");
  const q = parsed.data;

  const filter = {};
  if (q.student_id && mongoose.Types.ObjectId.isValid(q.student_id)) filter.student_id = q.student_id;
  if (q.status) filter.status = q.status;
  if (q.period) {
    const [y, m] = q.period.split("-").map(Number);
    filter.createdAt = {
      $gte: new Date(Date.UTC(y, m - 1, 1)),
      $lte: new Date(Date.UTC(y, m, 0, 23, 59, 59)),
    };
  }

  const page = q.page || 1;
  const limit = q.limit || 50;
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter)
      .populate({ path: "student_id", select: "name email" })
      .populate({ path: "invoice_id", select: "invoice_number status" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  return sendSuccess(
    res,
    rows.map((p) => paymentOut(p, { student: p.student_id, invoice: p.invoice_id })),
    "",
    { page, limit, total }
  );
}

/** Reconciliation: expected (sum of invoice.total_due_paise in period) vs received (sum of successful Payment in period) per course/category. */
async function reconciliation(req, res) {
  const schema = z.object({ period: z.string().regex(PERIOD_RE) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "period (YYYY-MM) is required");
  const period = parsed.data.period;
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59));

  const invoiceAgg = await Invoice.aggregate([
    { $match: { period_start: { $gte: start, $lte: end } } },
    {
      $lookup: { from: "courses", localField: "course_id", foreignField: "_id", as: "course" },
    },
    { $unwind: "$course" },
    {
      $group: {
        _id: { course_id: "$course_id", category: "$course.category", code: "$course.code", name: "$course.name" },
        invoice_count: { $sum: 1 },
        expected_paise: { $sum: "$total_due_paise" },
        paid_count: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
        received_paise: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$total_due_paise", 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        course_id: { $toString: "$_id.course_id" },
        category: "$_id.category",
        code: "$_id.code",
        name: "$_id.name",
        invoice_count: 1,
        expected_paise: 1,
        paid_count: 1,
        received_paise: 1,
        delta_paise: { $subtract: ["$expected_paise", "$received_paise"] },
      },
    },
    { $sort: { category: 1, name: 1 } },
  ]);

  const totals = invoiceAgg.reduce(
    (acc, r) => {
      acc.expected_paise += r.expected_paise;
      acc.received_paise += r.received_paise;
      acc.invoice_count += r.invoice_count;
      acc.paid_count += r.paid_count;
      return acc;
    },
    { expected_paise: 0, received_paise: 0, invoice_count: 0, paid_count: 0 }
  );
  totals.delta_paise = totals.expected_paise - totals.received_paise;

  return sendSuccess(res, { period, rows: invoiceAgg, totals });
}

const refundSchema = z.object({
  amount_paise: z.number().int().min(1).optional(), // defaults to remaining refundable
  reason: z.string().max(500).optional(),
});

function genMerchantRefundId(paymentId) {
  const shortP = String(paymentId).slice(-8);
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `RF${shortP}${ts}${rnd}`.toUpperCase();
}

async function refundPayment(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid payment id");
  const parsed = refundSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");

  const payment = await Payment.findById(id);
  if (!payment) return sendError(res, 404, "NOT_FOUND", "Payment not found");
  if (payment.status !== "success" && payment.status !== "partially_refunded") {
    return sendError(res, 409, "NOT_REFUNDABLE", `Cannot refund payment in status: ${payment.status}`);
  }

  const remaining = payment.amount_paise - (payment.refunded_paise || 0);
  const amount = parsed.data.amount_paise ?? remaining;
  if (amount <= 0 || amount > remaining) {
    return sendError(res, 400, "INVALID_AMOUNT", `Refund amount must be > 0 and <= remaining (${remaining} paise)`);
  }

  const merchantRefundId = genMerchantRefundId(payment._id);
  const refund = await Refund.create({
    payment_id: payment._id,
    invoice_id: payment.invoice_id,
    student_id: payment.student_id,
    amount_paise: amount,
    reason: parsed.data.reason || "",
    status: "initiated",
    merchant_refund_id: merchantRefundId,
    initiated_by_staff_id: req.staff?.sub,
  });

  try {
    await phonepe.initiateRefund({
      originalMerchantTransactionId: payment.merchant_transaction_id,
      merchantRefundId,
      amountPaise: amount,
    });
  } catch (err) {
    refund.status = "failed";
    await refund.save();
    return sendError(res, 502, "GATEWAY_ERROR", err.message || "PhonePe refund initiate failed");
  }

  // Optimistically apply local-state changes; webhook will confirm.
  refund.status = "pending";
  await refund.save();

  payment.refunded_paise = (payment.refunded_paise || 0) + amount;
  payment.status = payment.refunded_paise >= payment.amount_paise ? "refunded" : "partially_refunded";
  await payment.save();

  const invoice = await Invoice.findById(payment.invoice_id);
  if (invoice) {
    invoice.refunded_paise = (invoice.refunded_paise || 0) + amount;
    if (invoice.refunded_paise >= invoice.total_due_paise) {
      invoice.status = "refunded";
    } else {
      invoice.status = "partially_refunded";
    }
    await invoice.save();
  }

  return sendSuccess(res, refundOut(refund.toObject()), "Refund initiated");
}

async function listRefunds(req, res) {
  const rows = await Refund.find({}).sort({ createdAt: -1 }).limit(500).lean();
  return sendSuccess(res, rows.map(refundOut));
}

module.exports = {
  listPayments,
  reconciliation,
  refundPayment,
  listRefunds,
};
