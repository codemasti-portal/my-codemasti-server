// Payment reminder scheduler — sends two emails per pending invoice:
//   1. "Pre-due" 3 days before due_date (gates: reminder_pre_due_sent_at null)
//   2. "Overdue" 1+ days after due_date (gates: reminder_overdue_sent_at null)
//
// Toggle via env: BILLING_REMINDER_SCHEDULER=0 disables.
// Brevo failures are caught — the timestamp still gets set on success only, so a transient
// failure means the next tick retries.

const Invoice = require("../models/Invoice");
const Student = require("../models/Student");
const Course = require("../models/Course");
const { sendSimpleEmail } = require("./brevo");
const { formatINR } = require("../utils/money");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DAYS_BEFORE_DUE = Number(process.env.BILLING_REMINDER_DAYS_BEFORE_DUE || 3);

function isBrevoConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—";
}

function preDueEmail({ student, invoice, course, dueDate }) {
  const due = formatINR(invoice.total_due_paise);
  const subject = `Payment reminder: ${course.name} — ${due} due ${fmtDate(dueDate)}`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:auto;">
      <h2 style="margin:0 0 12px;">Upcoming payment</h2>
      <p>Hello ${student.name || "there"},</p>
      <p>Your <strong>${course.name}</strong> invoice <strong>${due}</strong> is due on <strong>${fmtDate(dueDate)}</strong>.</p>
      <p>Invoice <code>${invoice.invoice_number}</code> · period ${invoice.period_label || "—"}</p>
      <p style="margin-top:18px;">You can pay any time from <strong>My Courses → Fees</strong> in your CodeMasti dashboard.</p>
      <p style="color:#666;font-size:0.85rem;margin-top:24px;">If you've already paid, please ignore this email.</p>
    </div>`.trim();
  const textContent = [
    `Hello ${student.name || "there"},`,
    `Your ${course.name} invoice ${due} is due on ${fmtDate(dueDate)}.`,
    `Invoice ${invoice.invoice_number} · period ${invoice.period_label || "—"}`,
    `Pay from My Courses → Fees in your CodeMasti dashboard.`,
  ].join("\n");
  return { subject, htmlContent, textContent };
}

function overdueEmail({ student, invoice, course, dueDate }) {
  const due = formatINR(invoice.total_due_paise);
  const subject = `Overdue: ${course.name} — ${due} (due ${fmtDate(dueDate)})`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:auto;">
      <h2 style="margin:0 0 12px;color:#b91c1c;">Payment overdue</h2>
      <p>Hello ${student.name || "there"},</p>
      <p>Your <strong>${course.name}</strong> invoice of <strong>${due}</strong> was due on <strong>${fmtDate(dueDate)}</strong> and is now overdue.</p>
      <p>Invoice <code>${invoice.invoice_number}</code> · period ${invoice.period_label || "—"}</p>
      <p style="margin-top:18px;">Please pay at the earliest from <strong>My Courses → Fees</strong> in your dashboard to keep your access uninterrupted.</p>
      <p style="color:#666;font-size:0.85rem;margin-top:24px;">If you need help, reply to this email or reach out via the Support tab.</p>
    </div>`.trim();
  const textContent = [
    `Hello ${student.name || "there"},`,
    `Your ${course.name} invoice of ${due} was due on ${fmtDate(dueDate)} and is now overdue.`,
    `Invoice ${invoice.invoice_number} · period ${invoice.period_label || "—"}`,
    `Please pay at the earliest from My Courses → Fees in your dashboard.`,
  ].join("\n");
  return { subject, htmlContent, textContent };
}

async function processInvoice(invoice, kind) {
  const [student, course] = await Promise.all([
    Student.findById(invoice.student_id).select("name email").lean(),
    Course.findById(invoice.course_id).select("name").lean(),
  ]);
  if (!student || !course) return false;
  if (!student.email) return false;

  const dueDate = invoice.due_date;
  const builder = kind === "pre_due" ? preDueEmail : overdueEmail;
  const { subject, htmlContent, textContent } = builder({ student, invoice, course, dueDate });

  await sendSimpleEmail({ toEmail: student.email, subject, htmlContent, textContent });

  const setField = kind === "pre_due" ? "reminder_pre_due_sent_at" : "reminder_overdue_sent_at";
  await Invoice.updateOne({ _id: invoice._id, [setField]: null }, { $set: { [setField]: new Date() } });
  return true;
}

async function runReminderTick() {
  if (!isBrevoConfigured()) return; // silent no-op when Brevo isn't configured

  const now = new Date();
  const preDueUpper = new Date(now.getTime() + DAYS_BEFORE_DUE * 24 * 60 * 60 * 1000);

  // Pre-due: due_date in (now, now + DAYS_BEFORE_DUE], pending, never sent.
  const preDueCandidates = await Invoice.find({
    status: "pending",
    due_date: { $gt: now, $lte: preDueUpper },
    reminder_pre_due_sent_at: null,
  }).limit(200).lean();

  for (const inv of preDueCandidates) {
    try {
      await processInvoice(inv, "pre_due");
    } catch (err) {
      console.error("[BILLING_REMINDER_PRE_DUE_FAILED]", JSON.stringify({
        invoice_id: String(inv._id),
        message: err?.message || String(err),
      }));
    }
  }

  // Overdue: due_date < now (any amount of overdue), pending, never sent overdue reminder.
  const overdueCandidates = await Invoice.find({
    status: "pending",
    due_date: { $ne: null, $lt: now },
    reminder_overdue_sent_at: null,
  }).limit(200).lean();

  for (const inv of overdueCandidates) {
    try {
      await processInvoice(inv, "overdue");
    } catch (err) {
      console.error("[BILLING_REMINDER_OVERDUE_FAILED]", JSON.stringify({
        invoice_id: String(inv._id),
        message: err?.message || String(err),
      }));
    }
  }
}

function startPaymentReminderScheduler() {
  if (process.env.BILLING_REMINDER_SCHEDULER === "0") {
    console.log("[BILLING] Payment reminder scheduler disabled via env");
    return null;
  }
  if (!isBrevoConfigured()) {
    console.log("[BILLING] Payment reminder scheduler idle (BREVO not configured)");
  }
  const timer = setInterval(() => {
    runReminderTick().catch((e) => console.error("[BILLING_REMINDER_TICK_FAILED]", e?.message || e));
  }, CHECK_INTERVAL_MS);
  runReminderTick().catch((e) => console.error("[BILLING_REMINDER_BOOT_TICK_FAILED]", e?.message || e));
  return timer;
}

module.exports = { startPaymentReminderScheduler, runReminderTick };
