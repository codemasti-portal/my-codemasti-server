// Generate an Invoice for a given (enrollment × period).
// - Resolves subtotal from enrollment.fee_override_paise or course.base_fee_paise
// - Applies discounts via invoice-discount.service
// - On consumption of a referral credit, decrements `months` (or removes the queue item when 0)
// - Looks up most recent scholarship from ScorecardEntry in the linked batch for the previous month
// - Adds Student of the Month +5% when MonthlyLeaderboardBadge exists for that batch + previous month
//
// Wrapped in a Mongo session/transaction so credit consumption + invoice creation are atomic.

const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const StudentEnrollment = require("../models/StudentEnrollment");
const Course = require("../models/Course");
const Student = require("../models/Student");
const ScorecardEntry = require("../models/ScorecardEntry");
const MonthlyLeaderboardBadge = require("../models/MonthlyLeaderboardBadge");
const {
  computeDiscounts,
  nextConsumableReferralCredit,
} = require("./invoice-discount.service");
const monthlyBadgeSvc = require("./monthly-leaderboard-badge.service");
const { rupeesToPaise } = require("../utils/money");

function generateInvoiceNumber(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  // 6-char random suffix; per-doc unique index on invoice_number enforces collision protection.
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `INV-${yyyy}-${mm}-${suffix}`;
}

function periodLabelFor(date = new Date()) {
  return date.toLocaleString("en-US", { month: "long", year: "numeric" });
}

/** Previous calendar month as "YYYY-MM" (matches MonthlyLeaderboardBadge.period / scorecard window). */
function previousPeriodLabel(periodStart) {
  const d = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() - 1, 1));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

async function findLatestScholarship({ studentId, linkedBatchId, periodStart }) {
  if (!linkedBatchId || !periodStart) return null;
  // Policy: scholarship from a test in month X applies ONLY to the bill for month X+1.
  // If no qualifying test in the previous month, scholarship is revoked for this bill.
  //
  // For a June invoice (periodStart = 2026-06-01), the window is the whole of May:
  //   exam_date in [2026-05-01, 2026-06-01)
  const prevMonthStart = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() - 1, 1));
  const filter = {
    student_id: studentId,
    batch_id: linkedBatchId,
    exam_date: { $gte: prevMonthStart, $lt: periodStart },
    $or: [
      { scholarship_amount: { $gt: 0 } },
      { scholarship_percent: { $gt: 0 } },
    ],
  };
  const entry = await ScorecardEntry.findOne(filter).sort({ exam_date: -1, updatedAt: -1 }).lean();
  if (!entry) return null;
  const amtRupees = Number(entry.scholarship_amount);
  return {
    scholarship_amount_paise: Number.isFinite(amtRupees) && amtRupees > 0 ? rupeesToPaise(amtRupees) : 0,
    scholarship_percent: Number(entry.scholarship_percent || 0),
  };
}

/**
 * True when this student won Student of the Month for the previous month in the course's linked batch.
 * Finalizes the badge first (idempotent) so day-1 invoice cron still works if nobody opened achievements.
 */
async function isStudentOfMonthWinner({ studentId, linkedBatchId, periodStart }) {
  const scopeKey = String(linkedBatchId || "").trim().toLowerCase();
  if (!scopeKey || scopeKey.startsWith("solo:")) return false;
  const prevPeriod = previousPeriodLabel(periodStart);
  try {
    await monthlyBadgeSvc.finalizePeriodForScopeIfMissing(scopeKey, prevPeriod);
  } catch {
    /* ignore finalize errors — lookup may still find an existing badge */
  }
  const badge = await MonthlyLeaderboardBadge.findOne({
    period: prevPeriod,
    scope_key: scopeKey,
    student_id: studentId,
  })
    .select("_id")
    .lean();
  return Boolean(badge);
}

/**
 * Build & persist an invoice for one (enrollment × period). Idempotent within session: caller
 * should de-dupe before calling (e.g. check existing invoice for the period).
 *
 * @param {object} args
 * @param {string|ObjectId} args.enrollmentId
 * @param {Date} [args.periodStart]   defaults to start of current month UTC
 * @param {Date} [args.periodEnd]     defaults to end of current month UTC
 * @param {Date} [args.dueDate]
 * @param {string} [args.periodLabel]
 * @param {string} [args.generatedBy] "system" | "manual" | staff_id string
 * @param {string|null} [args.generatedByStaffId]
 * @returns {Promise<Invoice>}
 */
async function buildInvoiceForPeriod({
  enrollmentId,
  periodStart,
  periodEnd,
  dueDate,
  periodLabel,
  generatedBy = "system",
  generatedByStaffId = null,
}) {
  const now = new Date();
  const ps = periodStart || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const pe = periodEnd || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));

  const enrollment = await StudentEnrollment.findById(enrollmentId);
  if (!enrollment) throw new Error("Enrollment not found");
  if (enrollment.status !== "active") throw new Error(`Enrollment is ${enrollment.status}; cannot bill`);

  const [student, course] = await Promise.all([
    Student.findById(enrollment.student_id),
    Course.findById(enrollment.course_id).lean(),
  ]);
  if (!student) throw new Error("Student not found");
  if (!course) throw new Error("Course not found");
  if (course.base_fee_paise == null || course.base_fee_paise < 0) {
    throw new Error(`Course ${course.code} has invalid base_fee_paise`);
  }

  const subtotalPaise = enrollment.fee_override_paise != null
    ? enrollment.fee_override_paise
    : course.base_fee_paise;

  // First invoice for this enrollment? (count = 0 means yes)
  const existingCount = await Invoice.countDocuments({ enrollment_id: enrollment._id });
  const isFirstInvoiceForCourse = existingCount === 0;

  // Decision: global per-student credits (referral fee credit + the one-time registration discount)
  // apply ONLY on the student's PRIMARY batch invoice — so a multi-batch student consumes them once
  // per month, not once per batch. Non-primary invoices get base fee + scholarship only.
  const isPrimaryBatchInvoice =
    String(student.batch_id || "").toLowerCase().trim() !== "" &&
    String(course.linked_batch_id || "").toLowerCase().trim() === String(student.batch_id || "").toLowerCase().trim();

  const { entry: referralCredit, index: referralIndex } = isPrimaryBatchInvoice
    ? nextConsumableReferralCredit(student.referral_benefits_queue)
    : { entry: null, index: -1 };

  const scholarshipEntry = await findLatestScholarship({
    studentId: student._id,
    linkedBatchId: course.linked_batch_id,
    periodStart: ps,
  });

  const isStudentOfMonth = await isStudentOfMonthWinner({
    studentId: student._id,
    linkedBatchId: course.linked_batch_id,
    periodStart: ps,
  });

  const breakdown = computeDiscounts({
    student,
    subtotalPaise,
    isFirstInvoiceForCourse: isFirstInvoiceForCourse && isPrimaryBatchInvoice,
    activeReferralCredit: referralCredit,
    scholarshipEntry,
    isStudentOfMonth,
  });

  const session = await mongoose.startSession();
  let invoice;
  try {
    await session.withTransaction(async () => {
      // Consume the referral credit (decrement months, remove if 0)
      if (referralCredit && referralIndex >= 0 && breakdown.referral_paise > 0) {
        const queue = student.referral_benefits_queue || [];
        const next = queue.slice();
        const item = { ...next[referralIndex].toObject?.() ?? next[referralIndex] };
        item.months = Math.max(0, (Number(item.months) || 0) - 1);
        if (item.months <= 0) {
          next.splice(referralIndex, 1);
        } else {
          next[referralIndex] = item;
        }
        student.referral_benefits_queue = next;
        await student.save({ session });
      }

      // Zero out the registration discount after first use
      if (isFirstInvoiceForCourse && breakdown.registration_paise > 0) {
        student.registration_fee_discount_percent = 0;
        await student.save({ session });
      }

      const created = await Invoice.create(
        [
          {
            invoice_number: generateInvoiceNumber(now),
            student_id: student._id,
            enrollment_id: enrollment._id,
            course_id: course._id,
            period_label: periodLabel || periodLabelFor(ps),
            period_start: ps,
            period_end: pe,
            subtotal_paise: subtotalPaise,
            scholarship_discount_paise: breakdown.scholarship_paise,
            student_of_month_discount_paise: breakdown.student_of_month_paise,
            referral_discount_paise: breakdown.referral_paise,
            registration_discount_paise: breakdown.registration_paise,
            total_due_paise: breakdown.total_due_paise,
            status: "pending",
            due_date: dueDate || null,
            generated_by: generatedBy,
            generated_by_staff_id: generatedByStaffId,
          },
        ],
        { session }
      );
      invoice = created[0];
    });
  } finally {
    session.endSession();
  }
  return invoice;
}

module.exports = {
  buildInvoiceForPeriod,
  generateInvoiceNumber,
  periodLabelFor,
  previousPeriodLabel,
  isStudentOfMonthWinner,
};
