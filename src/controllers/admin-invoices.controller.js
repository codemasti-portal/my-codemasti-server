const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const StudentEnrollment = require("../models/StudentEnrollment");
const Course = require("../models/Course");
const Student = require("../models/Student");
const { buildInvoiceForPeriod } = require("../services/invoice-generator.service");

const PERIOD_RE = /^\d{4}-\d{2}$/;

function rowOut(i, populated = {}) {
  return {
    id: String(i._id),
    invoice_number: i.invoice_number,
    student_id: String(i.student_id),
    enrollment_id: String(i.enrollment_id),
    course_id: String(i.course_id),
    period_label: i.period_label || "",
    period_start: i.period_start,
    period_end: i.period_end,
    subtotal_paise: i.subtotal_paise,
    scholarship_discount_paise: i.scholarship_discount_paise,
    referral_discount_paise: i.referral_discount_paise,
    registration_discount_paise: i.registration_discount_paise,
    manual_adjustment_paise: i.manual_adjustment_paise,
    manual_adjustment_reason: i.manual_adjustment_reason || "",
    total_due_paise: i.total_due_paise,
    status: i.status,
    due_date: i.due_date,
    paid_at: i.paid_at,
    refunded_paise: i.refunded_paise || 0,
    notes: i.notes || "",
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    student: populated.student
      ? { id: String(populated.student._id), name: populated.student.name, email: populated.student.email }
      : null,
    course: populated.course
      ? { id: String(populated.course._id), code: populated.course.code, name: populated.course.name }
      : null,
  };
}

function periodFromLabel(label) {
  // "2026-05" → { start: 2026-05-01 UTC, end: 2026-05-31 23:59:59 UTC }
  const [y, m] = label.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 0, 23, 59, 59)),
  };
}

async function listInvoices(req, res) {
  const schema = z.object({
    student_id: z.string().optional(),
    course_id: z.string().optional(),
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
  if (q.course_id && mongoose.Types.ObjectId.isValid(q.course_id)) filter.course_id = q.course_id;
  if (q.status) filter.status = q.status;
  if (q.period) {
    const { start, end } = periodFromLabel(q.period);
    filter.period_start = { $gte: start, $lte: end };
  }

  const page = q.page || 1;
  const limit = q.limit || 50;
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    Invoice.countDocuments(filter),
    Invoice.find(filter)
      .populate({ path: "student_id", select: "name email" })
      .populate({ path: "course_id", select: "code name" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  return sendSuccess(
    res,
    rows.map((i) => rowOut(i, { student: i.student_id, course: i.course_id })),
    "",
    { page, limit, total }
  );
}

async function getInvoice(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const [i, payments] = await Promise.all([
    Invoice.findById(id)
      .populate({ path: "student_id", select: "name email" })
      .populate({ path: "course_id", select: "code name" })
      .lean(),
    Payment.find({ invoice_id: id }).sort({ createdAt: -1 }).lean(),
  ]);
  if (!i) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

  const base = rowOut(i, { student: i.student_id, course: i.course_id });
  base.payments = payments.map((p) => ({
    id: String(p._id),
    merchant_transaction_id: p.merchant_transaction_id,
    phonepe_transaction_id: p.phonepe_transaction_id || "",
    status: p.status,
    payment_method: p.payment_method,
    amount_paise: p.amount_paise,
    refunded_paise: p.refunded_paise || 0,
    failure_reason: p.failure_reason || "",
    initiated_at: p.initiated_at,
    completed_at: p.completed_at,
    created_at: p.createdAt,
  }));
  return sendSuccess(res, base);
}

const createSchema = z.object({
  enrollment_id: z.string().min(1),
  period: z.string().regex(PERIOD_RE),
  due_date: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

async function createInvoice(req, res) {
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const { enrollment_id, period, due_date, notes } = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(enrollment_id)) return sendError(res, 400, "INVALID_ID", "Invalid enrollment_id");

  const { start, end } = periodFromLabel(period);

  // Idempotency: skip if an invoice already exists for this enrollment in this period.
  const existing = await Invoice.findOne({
    enrollment_id,
    period_start: { $gte: start, $lte: end },
  }).lean();
  if (existing) {
    return sendError(res, 409, "ALREADY_EXISTS", "Invoice already exists for this enrollment + period");
  }

  let invoice;
  try {
    invoice = await buildInvoiceForPeriod({
      enrollmentId: enrollment_id,
      periodStart: start,
      periodEnd: end,
      dueDate: due_date || null,
      generatedBy: "manual",
      generatedByStaffId: req.staff?.sub,
    });
  } catch (err) {
    return sendError(res, 400, "GENERATE_FAILED", err.message);
  }

  if (notes) {
    invoice.notes = notes;
    await invoice.save();
  }
  return sendSuccess(res, rowOut(invoice.toObject()), "Invoice created");
}

const bulkSchema = z.object({
  course_id: z.string().min(1),
  period: z.string().regex(PERIOD_RE),
  due_date: z.coerce.date().nullable().optional(),
});

async function bulkGenerateForCourse(req, res) {
  const parsed = bulkSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const { course_id, period, due_date } = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(course_id)) return sendError(res, 400, "INVALID_ID", "Invalid course_id");

  const { start, end } = periodFromLabel(period);
  const enrollments = await StudentEnrollment.find({ course_id, status: "active" }).select("_id student_id").lean();

  // Skip enrollments already invoiced for this period.
  const existingInvoices = await Invoice.find({
    course_id,
    period_start: { $gte: start, $lte: end },
  })
    .select("enrollment_id")
    .lean();
  const invoiced = new Set(existingInvoices.map((i) => String(i.enrollment_id)));

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const e of enrollments) {
    if (invoiced.has(String(e._id))) {
      skipped += 1;
      continue;
    }
    try {
      await buildInvoiceForPeriod({
        enrollmentId: e._id,
        periodStart: start,
        periodEnd: end,
        dueDate: due_date || null,
        generatedBy: "manual_bulk",
        generatedByStaffId: req.staff?.sub,
      });
      created += 1;
    } catch (err) {
      errors.push({ enrollment_id: String(e._id), message: err.message });
    }
  }

  return sendSuccess(
    res,
    { created, skipped, errors, total_enrollments: enrollments.length },
    `Bulk generation complete: ${created} created, ${skipped} skipped, ${errors.length} errors`
  );
}

const patchSchema = z.object({
  manual_adjustment_paise: z.number().int().optional(),
  manual_adjustment_reason: z.string().max(500).optional(),
  due_date: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["pending", "paid", "cancelled"]).optional(),
});

async function patchInvoice(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  const body = parsed.data;

  const invoice = await Invoice.findById(id);
  if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

  // Status transitions are limited from the admin UI:
  //   - pending → paid    : "mark paid offline" (no Payment row)
  //   - pending → cancelled
  //   - paid    → cancelled (admin reversal; refund flow is separate)
  if (body.status && body.status !== invoice.status) {
    if (body.status === "paid") {
      if (invoice.status !== "pending") return sendError(res, 409, "INVALID_TRANSITION", `Cannot mark ${invoice.status} as paid`);
      invoice.status = "paid";
      invoice.paid_at = new Date();
    } else if (body.status === "cancelled") {
      invoice.status = "cancelled";
    } else if (body.status === "pending") {
      if (invoice.status !== "cancelled") return sendError(res, 409, "INVALID_TRANSITION", "Only cancelled → pending allowed");
      invoice.status = "pending";
    }
  }

  if (body.manual_adjustment_paise !== undefined) {
    invoice.manual_adjustment_paise = body.manual_adjustment_paise;
    // Recompute total_due_paise
    invoice.total_due_paise = Math.max(
      0,
      invoice.subtotal_paise -
        invoice.scholarship_discount_paise -
        invoice.referral_discount_paise -
        invoice.registration_discount_paise +
        body.manual_adjustment_paise
    );
  }
  if (body.manual_adjustment_reason !== undefined) invoice.manual_adjustment_reason = body.manual_adjustment_reason;
  if (body.due_date !== undefined) invoice.due_date = body.due_date;
  if (body.notes !== undefined) invoice.notes = body.notes;

  await invoice.save();
  return sendSuccess(res, rowOut(invoice.toObject()), "Invoice updated");
}

async function deleteInvoice(req, res) {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return sendError(res, 400, "INVALID_ID", "Invalid id");

  const invoice = await Invoice.findById(id).select("status invoice_number").lean();
  if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

  // Only pending or cancelled invoices can be deleted. Paid/refunded invoices are part of the ledger.
  if (!["pending", "cancelled"].includes(invoice.status)) {
    return sendError(
      res,
      409,
      "DELETE_BLOCKED",
      `Cannot delete a ${invoice.status} invoice. Only pending or cancelled invoices can be deleted.`
    );
  }

  // Defensive: block if any payments exist against this invoice.
  const payCount = await Payment.countDocuments({ invoice_id: id });
  if (payCount > 0) {
    return sendError(
      res,
      409,
      "DELETE_BLOCKED",
      `Cannot delete: ${payCount} payment(s) exist against ${invoice.invoice_number}. Cancel instead.`
    );
  }

  await Invoice.deleteOne({ _id: id });
  return sendSuccess(res, { id, invoice_number: invoice.invoice_number }, "Invoice deleted");
}

module.exports = {
  listInvoices,
  getInvoice,
  createInvoice,
  bulkGenerateForCourse,
  patchInvoice,
  deleteInvoice,
};
