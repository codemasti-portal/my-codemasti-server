// Monthly invoice scheduler. Generates invoices for every active enrollment of every
// active monthly-billed course on the 1st of each calendar month (UTC).
//
// Idempotent: the invoice generator skips enrollments that already have an invoice for
// the period. So even if the scheduler ticks fire twice on the same day, no duplicates.
//
// Toggle via env: BILLING_INVOICE_SCHEDULER=0 disables.

const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");
const Invoice = require("../models/Invoice");
const { buildInvoiceForPeriod } = require("./invoice-generator.service");

// Tick hourly — cheap; the day-1 gate ensures we only do real work once per month.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function currentPeriodBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return { now, start, end };
}

async function runMonthlyInvoiceTick() {
  const { now, start, end } = currentPeriodBounds();
  // Only run on the 1st of the month.
  if (now.getUTCDate() !== 1) return;

  // Find active courses billed monthly.
  const courses = await Course.find({ is_active: true, billing_mode: "monthly" }).select("_id code base_fee_paise").lean();
  if (!courses.length) return;

  for (const course of courses) {
    if (!Number.isFinite(course.base_fee_paise) || course.base_fee_paise <= 0) {
      // Skip courses with no fee configured — admin needs to set it first.
      continue;
    }
    const enrollments = await StudentEnrollment.find({
      course_id: course._id,
      status: "active",
    }).select("_id").lean();
    if (!enrollments.length) continue;

    // De-dupe: list existing invoices for this course+period to avoid re-runs.
    const existing = await Invoice.find({
      course_id: course._id,
      period_start: { $gte: start, $lte: end },
    }).select("enrollment_id").lean();
    const invoiced = new Set(existing.map((i) => String(i.enrollment_id)));

    for (const e of enrollments) {
      if (invoiced.has(String(e._id))) continue;
      try {
        await buildInvoiceForPeriod({
          enrollmentId: e._id,
          periodStart: start,
          periodEnd: end,
          generatedBy: "system_cron",
        });
      } catch (err) {
        console.error("[MONTHLY_INVOICE_GENERATE_FAILED]", JSON.stringify({
          enrollment_id: String(e._id),
          course_code: course.code,
          message: err?.message || String(err),
        }));
      }
    }
  }
}

function startMonthlyInvoiceScheduler() {
  if (process.env.BILLING_INVOICE_SCHEDULER === "0") {
    console.log("[BILLING] Monthly invoice scheduler disabled via env");
    return null;
  }
  const timer = setInterval(() => {
    runMonthlyInvoiceTick().catch((e) => {
      console.error("[MONTHLY_INVOICE_TICK_FAILED]", e?.message || e);
    });
  }, CHECK_INTERVAL_MS);
  // Also fire once at boot — if the server restarted on the 1st and we missed the prior tick.
  runMonthlyInvoiceTick().catch((e) => {
    console.error("[MONTHLY_INVOICE_BOOT_TICK_FAILED]", e?.message || e);
  });
  return timer;
}

module.exports = { startMonthlyInvoiceScheduler, runMonthlyInvoiceTick };
