const Notification = require("../models/Notification");
const Student = require("../models/Student");
const { studentsInBatchesFilterResolved } = require("../utils/student-batch-context");
const { sendSimpleEmail } = require("./brevo");

function isDuplicateKeyError(err) {
  // Mongo duplicate key error code is 11000.
  return Boolean(err && (err.code === 11000 || err?.name === "MongoServerError" && String(err?.message || "").includes("E11000")));
}

function fmtWhenLocal(dateStr, timeRange) {
  const base = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(base.getTime())) return `${dateStr} ${timeRange || ""}`.trim();
  return `${base.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" })} ${timeRange || ""}`.trim();
}

function getStudentPortalBase() {
  return String(process.env.STUDENT_PORTAL_URL || "").trim().replace(/\/$/, "");
}

function portalLink(pathname) {
  const base = getStudentPortalBase();
  const p = String(pathname || "").trim();
  if (!base || !p) return "";
  return `${base}${p.startsWith("/") ? "" : "/"}${p}`;
}

function getSupportEmail() {
  return String(process.env.SUPPORT_EMAIL || "support@codemasti.com").trim();
}

function getEmailLogoUrl() {
  return String(process.env.EMAIL_LOGO_URL || "").trim();
}

function getBrandColors() {
  // Defaults match current portal orange primary.
  const primary = String(process.env.EMAIL_BRAND_PRIMARY || "#f97316").trim();
  const primaryDark = String(process.env.EMAIL_BRAND_PRIMARY_DARK || "#ea580c").trim();
  const headerFrom = String(process.env.EMAIL_BRAND_HEADER_FROM || "#0b1220").trim();
  const headerTo = String(process.env.EMAIL_BRAND_HEADER_TO || "#1f2937").trim();
  return { primary, primaryDark, headerFrom, headerTo };
}

function renderEmailTemplate({ title, greeting, intro, details, primaryAction, secondaryAction }) {
  const supportEmail = getSupportEmail();
  const logoUrl = getEmailLogoUrl();
  const brand = String(process.env.BREVO_SENDER_NAME || "CodeMasti").trim();
  const colors = getBrandColors();

  const btn = (a) => {
    if (!a?.href) return "";
    const bg = a.variant === "secondary" ? "#ffffff" : colors.primary;
    const fg = a.variant === "secondary" ? "#111827" : "#ffffff";
    const border = a.variant === "secondary" ? "1px solid #e5e7eb" : `1px solid ${colors.primaryDark}`;
    return `
      <a href="${a.href}" target="_blank" rel="noopener noreferrer"
        style="display:inline-block;text-decoration:none;background:${bg};color:${fg};border:${border};padding:12px 16px;border-radius:10px;font-weight:700;font-size:14px;margin-right:10px">
        ${a.label}
      </a>
    `.trim();
  };

  return `
  <div style="background:#f6f7fb;padding:24px 0">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #eef0f5;border-radius:16px;overflow:hidden">
      <div style="padding:18px 22px;background:linear-gradient(135deg,${colors.headerFrom},${colors.headerTo});color:#fff">
        <div style="display:flex;align-items:center;gap:12px">
          ${logoUrl ? `<img src="${logoUrl}" alt="${brand}" style="height:34px;width:auto;display:block"/>` : ""}
          <div style="font-weight:800;font-size:16px;letter-spacing:0.3px">${brand}</div>
        </div>
      </div>
      <div style="padding:22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;line-height:1.5">
        <h2 style="margin:0 0 12px;font-size:20px">${title}</h2>
        ${greeting ? `<p style="margin:0 0 8px">${greeting}</p>` : ""}
        ${intro ? `<p style="margin:0 0 14px;color:#374151">${intro}</p>` : ""}
        ${
          details && details.length
            ? `<div style="border:1px solid #eef0f5;background:#fafbff;border-radius:12px;padding:14px 16px;margin:14px 0">
                 ${details.map((d) => `<div style="margin:6px 0"><span style="color:#6b7280;font-weight:700">${d.label}:</span> <span style="color:#111827">${d.value}</span></div>`).join("")}
               </div>`
            : ""
        }
        <div style="margin:16px 0 4px">
          ${btn(primaryAction)}
          ${btn(secondaryAction)}
        </div>
        <p style="margin:14px 0 0;color:#6b7280;font-size:12px">
          Need help? Email us at <a href="mailto:${supportEmail}" style="color:${colors.primary};text-decoration:none;font-weight:700">${supportEmail}</a>.
        </p>
      </div>
      <div style="padding:14px 22px;background:#f9fafb;color:#9ca3af;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:12px">
        © ${new Date().getFullYear()} ${brand}. All rights reserved.
      </div>
    </div>
  </div>
  `.trim();
}

async function createNotificationOnce({
  studentId,
  dedupeKey,
  type,
  title,
  body,
  deep_link,
  ref_id,
}) {
  try {
    const doc = await Notification.create({
      student_id: studentId,
      type,
      title,
      body,
      deep_link: deep_link || "",
      ref_id: ref_id || "",
      dedupe_key: dedupeKey || "",
    });
    return { created: true, doc };
  } catch (e) {
    if (isDuplicateKeyError(e)) return { created: false, doc: null };
    throw e;
  }
}

async function sendNotificationEmail({ notificationId, toEmail, subject, htmlContent, textContent }) {
  await sendSimpleEmail({ toEmail, subject, htmlContent, textContent });
  await Notification.updateOne(
    { _id: notificationId, email_sent_at: null },
    { $set: { email_to: String(toEmail || "").trim(), email_sent_at: new Date() } }
  );
}

async function notifyStudentsForSlot({
  slot,
  type,
  title,
  body,
  deep_link,
  dedupePrefix,
  email,
}) {
  const batchId = String(slot?.batch_id || "").trim().toLowerCase();
  if (!batchId) return { created: 0, emailed: 0 };
  const sectionId = String(slot?.section_id || "").trim().toLowerCase();

  const studentFilter = await studentsInBatchesFilterResolved([batchId], { sectionId });

  const students = await Student.find(studentFilter).select("_id name email").lean();
  let created = 0;
  let emailed = 0;

  for (const s of students) {
    const dedupeKey = `${dedupePrefix}:${String(slot._id)}:${String(s._id)}`;
    const res = await createNotificationOnce({
      studentId: s._id,
      dedupeKey,
      type,
      title,
      body,
      deep_link,
      ref_id: String(slot._id),
    });
    if (!res.created) continue;
    created += 1;

    const toEmail = String(s.email || "").trim();
    const emailPayload =
      typeof email === "function"
        ? email({ student: s, slot })
        : email;
    if (emailPayload && toEmail) {
      try {
        await sendNotificationEmail({
          notificationId: res.doc._id,
          toEmail,
          subject: emailPayload.subject,
          htmlContent: emailPayload.htmlContent,
          textContent: emailPayload.textContent,
        });
        emailed += 1;
      } catch (e) {
        // Email failing should not break notification creation.
        console.error("[STUDENT_NOTIFICATION_EMAIL_FAILED]", e?.message || e);
      }
    }
  }

  return { created, emailed };
}

function buildClassStart10mEmail({ studentName, slot }) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const subject = `Reminder: class starts in 10 minutes (${slot.subject || "Class"})`;
  const meet = String(slot.meet_link || "").trim() || "Not set";
  const timetableUrl = portalLink("/timetable");
  const htmlContent = renderEmailTemplate({
    title: "Class starts in 10 minutes",
    greeting: `Hi ${studentName || "Student"},`,
    intro: "Your class starts in 10 minutes. You can join from the button below.",
    details: [
      { label: "Subject", value: slot.subject || "N/A" },
      { label: "Topic", value: slot.topic || "N/A" },
      { label: "Instructor", value: slot.teacher || "N/A" },
      { label: "When", value: whenText },
    ],
    primaryAction: meet && meet !== "Not set" ? { label: "Join class", href: meet } : null,
    secondaryAction: timetableUrl ? { label: "Open timetable", href: timetableUrl, variant: "secondary" } : null,
  });
  const textContent = [
    `Hello ${studentName || "Student"},`,
    "Your class starts in 10 minutes.",
    `Subject: ${slot.subject || "N/A"}`,
    `Topic: ${slot.topic || "N/A"}`,
    `Instructor: ${slot.teacher || "N/A"}`,
    `When: ${whenText}`,
    `Meet link: ${meet}`,
    timetableUrl ? `Portal: ${timetableUrl}` : null,
    `Support: ${getSupportEmail()}`,
  ].filter(Boolean).join("\n");
  return { subject, htmlContent, textContent };
}

function buildResourceUploadedEmail({ studentName, slot, kind }) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const isNotes = kind === "notes";
  const label = isNotes ? "Notes" : "Recording";
  const url = String(isNotes ? slot.notes_link : slot.recording_link).trim();
  const lecturesUrl = portalLink("/lectures");
  const subject = `${label} uploaded: ${slot.subject || "Class"} (${whenText})`;
  const htmlContent = renderEmailTemplate({
    title: `${label} uploaded`,
    greeting: `Hi ${studentName || "Student"},`,
    intro: `${label} has been uploaded for your class. Open it using the buttons below.`,
    details: [
      { label: "Subject", value: slot.subject || "N/A" },
      { label: "Topic", value: slot.topic || "N/A" },
      { label: "Instructor", value: slot.teacher || "N/A" },
      { label: "When", value: whenText },
    ],
    primaryAction: url ? { label: `Open ${label.toLowerCase()}`, href: url } : null,
    secondaryAction: lecturesUrl ? { label: "Open Lectures", href: lecturesUrl, variant: "secondary" } : null,
  });
  const textContent = [
    `Hello ${studentName || "Student"},`,
    `${label} has been uploaded for your class.`,
    `Subject: ${slot.subject || "N/A"}`,
    `Topic: ${slot.topic || "N/A"}`,
    `Instructor: ${slot.teacher || "N/A"}`,
    `When: ${whenText}`,
    `Link: ${url}`,
    lecturesUrl ? `Portal: ${lecturesUrl}` : null,
    `Support: ${getSupportEmail()}`,
  ].filter(Boolean).join("\n");
  return { subject, htmlContent, textContent };
}

module.exports = {
  notifyStudentsForSlot,
  buildClassStart10mEmail,
  buildResourceUploadedEmail,
  fmtWhenLocal,
};

