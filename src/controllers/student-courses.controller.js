// Student-facing course/enrollment endpoints.
// Surfaces: Courses page (list), Course detail page (with Fees tab data).

const mongoose = require("mongoose");
const { sendSuccess, sendError } = require("../utils/response");
const StudentEnrollment = require("../models/StudentEnrollment");
const Course = require("../models/Course");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const ManualPayment = require("../models/ManualPayment");

const STATUS_RANK = { active: 0, completed: 1, cancelled: 2 };

function courseRow(course) {
  if (!course) return null;
  return {
    id: String(course._id),
    code: course.code,
    name: course.name,
    category: course.category,
    description: course.description || "",
    duration_months: course.duration_months,
    billing_mode: course.billing_mode,
    base_fee_paise: course.base_fee_paise,
    starts_on: course.starts_on,
    ends_on: course.ends_on,
    linked_batch_id: course.linked_batch_id || "",
  };
}

function invoiceRow(invoice) {
  return {
    id: String(invoice._id),
    invoice_number: invoice.invoice_number,
    period_label: invoice.period_label || "",
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    subtotal_paise: invoice.subtotal_paise,
    scholarship_discount_paise: invoice.scholarship_discount_paise,
    student_of_month_discount_paise: invoice.student_of_month_discount_paise || 0,
    referral_discount_paise: invoice.referral_discount_paise,
    registration_discount_paise: invoice.registration_discount_paise,
    manual_adjustment_paise: invoice.manual_adjustment_paise,
    total_due_paise: invoice.total_due_paise,
    status: invoice.status,
    due_date: invoice.due_date,
    paid_at: invoice.paid_at,
    refunded_paise: invoice.refunded_paise || 0,
    created_at: invoice.createdAt,
  };
}

function paymentRow(payment) {
  return {
    id: String(payment._id),
    invoice_id: String(payment.invoice_id),
    amount_paise: payment.amount_paise,
    merchant_transaction_id: payment.merchant_transaction_id,
    status: payment.status,
    payment_method: payment.payment_method,
    initiated_at: payment.initiated_at,
    completed_at: payment.completed_at,
  };
}

/** GET /students/courses — all enrollments for the logged-in student with pending dues summary. */
async function listMyCourses(req, res) {
  const sid = req.user?.sub;
  if (!mongoose.Types.ObjectId.isValid(sid)) {
    return sendError(res, 400, "INVALID_USER", "Invalid session");
  }

  const enrollments = await StudentEnrollment.find({ student_id: sid })
    .populate({ path: "course_id" })
    .lean();

  const enrollmentIds = enrollments.map((e) => e._id);
  let pendingByEnrollment = new Map();
  if (enrollmentIds.length) {
    const agg = await Invoice.aggregate([
      { $match: { enrollment_id: { $in: enrollmentIds }, status: "pending" } },
      {
        $group: {
          _id: "$enrollment_id",
          count: { $sum: 1 },
          total_paise: { $sum: "$total_due_paise" },
          earliest_due: { $min: "$due_date" },
        },
      },
    ]);
    pendingByEnrollment = new Map(agg.map((a) => [String(a._id), a]));
  }

  const rows = enrollments
    .map((e) => {
      const summary = pendingByEnrollment.get(String(e._id));
      return {
        enrollment_id: String(e._id),
        status: e.status,
        started_on: e.started_on,
        ended_on: e.ended_on,
        course: courseRow(e.course_id),
        fee_override_paise: e.fee_override_paise ?? null,
        pending_invoice_count: summary?.count || 0,
        pending_total_paise: summary?.total_paise || 0,
        earliest_due_date: summary?.earliest_due || null,
      };
    })
    .filter((r) => r.course) // skip enrollments whose course was deleted
    // Completed enrollments stay visible — a finished program is exactly where a student
    // wants to see their past invoices/receipts, not just outstanding ones. Only cancelled
    // enrollments (admin bookkeeping, e.g. a mistaken signup) are hidden by default, unless
    // they still have pending invoices the student needs to resolve.
    .filter((r) => r.status !== "cancelled" || r.pending_invoice_count > 0);

  rows.sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 99;
    const sb = STATUS_RANK[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return new Date(b.started_on || 0) - new Date(a.started_on || 0);
  });

  const totalOutstandingPaise = rows.reduce((s, r) => s + (r.pending_total_paise || 0), 0);
  const totalPendingCount = rows.reduce((s, r) => s + (r.pending_invoice_count || 0), 0);

  return sendSuccess(res, rows, "", {
    total_outstanding_paise: totalOutstandingPaise,
    total_pending_count: totalPendingCount,
  });
}

/** GET /students/courses/:enrollmentId — one enrollment with its invoices + payment history. */
async function getMyCourseDetail(req, res) {
  const sid = req.user?.sub;
  const { enrollmentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(sid)) {
    return sendError(res, 400, "INVALID_USER", "Invalid session");
  }
  if (!mongoose.Types.ObjectId.isValid(enrollmentId)) {
    return sendError(res, 400, "INVALID_ID", "Invalid enrollment id");
  }

  const enrollment = await StudentEnrollment.findOne({ _id: enrollmentId, student_id: sid }).lean();
  if (!enrollment) {
    return sendError(res, 404, "NOT_FOUND", "Enrollment not found");
  }
  const course = await Course.findById(enrollment.course_id).lean();
  if (!course) {
    return sendError(res, 404, "NOT_FOUND", "Course not found");
  }

  const invoices = await Invoice.find({ enrollment_id: enrollmentId, student_id: sid })
    .sort({ period_start: -1, createdAt: -1 })
    .lean();

  const invoiceIds = invoices.map((i) => i._id);
  const payments = invoiceIds.length
    ? await Payment.find({ invoice_id: { $in: invoiceIds }, student_id: sid })
        .sort({ initiated_at: -1 })
        .lean()
    : [];

  const paymentsByInvoice = new Map();
  for (const p of payments) {
    const key = String(p.invoice_id);
    if (!paymentsByInvoice.has(key)) paymentsByInvoice.set(key, []);
    paymentsByInvoice.get(key).push(paymentRow(p));
  }

  // Latest manual-UPI proof per invoice, so the Fees tab can show "Under review" / "Rejected".
  const manualByInvoice = new Map();
  if (invoiceIds.length) {
    const manuals = await ManualPayment.find({ invoice_id: { $in: invoiceIds }, student_id: sid })
      .sort({ createdAt: -1 })
      .lean();
    for (const m of manuals) {
      const key = String(m.invoice_id);
      if (!manualByInvoice.has(key)) {
        manualByInvoice.set(key, {
          id: String(m._id),
          status: m.status,
          review_note: m.review_note || "",
          utr_reference: m.utr_reference || "",
          screenshot_url: m.screenshot_url || "",
          created_at: m.createdAt,
        });
      }
    }
  }

  const totalOutstandingPaise = invoices
    .filter((i) => i.status === "pending")
    .reduce((s, i) => s + (i.total_due_paise || 0), 0);

  return sendSuccess(res, {
    enrollment: {
      id: String(enrollment._id),
      status: enrollment.status,
      started_on: enrollment.started_on,
      ended_on: enrollment.ended_on,
      fee_override_paise: enrollment.fee_override_paise ?? null,
      notes: enrollment.notes || "",
    },
    course: courseRow(course),
    invoices: invoices.map((i) => ({
      ...invoiceRow(i),
      payments: paymentsByInvoice.get(String(i._id)) || [],
      manual_payment: manualByInvoice.get(String(i._id)) || null,
    })),
    total_outstanding_paise: totalOutstandingPaise,
  });
}

module.exports = { listMyCourses, getMyCourseDetail };
