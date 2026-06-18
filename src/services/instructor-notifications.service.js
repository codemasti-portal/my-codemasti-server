const Staff = require("../models/Staff");
const { sendSimpleEmail } = require("./brevo");
const { emitEventNotification } = require("./staffPanelNotification.service");

function fmtWhenLocal(dateStr, timeRange) {
  const base = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(base.getTime())) return `${dateStr} ${timeRange || ""}`.trim();
  return `${base.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" })} ${timeRange || ""}`.trim();
}

function getStaffPortalBase() {
  return String(process.env.ADMIN_PORTAL_URL || "").trim().replace(/\/$/, "");
}

function portalLink(pathname) {
  const base = getStaffPortalBase();
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

async function resolveInstructorRecipientsByName(name) {
  const n = String(name || "").trim();
  if (!n) return [];
  const rows = await Staff.find({
    role: { $in: ["instructor", "mentor"] },
    is_active: true,
    name: n,
  })
    .select("_id name email role")
    .lean();
  return rows || [];
}

async function resolveInstructorRecipientsForSlot(slot) {
  // Prefer direct staff_id lookup — avoids name-collision bugs entirely.
  if (slot.staff_id) {
    const mongoose = require("mongoose");
    const staffId = slot.staff_id;
    if (mongoose.isValidObjectId(String(staffId))) {
      const row = await Staff.findOne({
        _id: staffId,
        role: { $in: ["instructor", "mentor"] },
        is_active: true,
      })
        .select("_id name email role")
        .lean();
      if (row) return [row];
    }
  }
  // Fall back to name matching (legacy slots without staff_id).
  return resolveInstructorRecipientsByName(slot.teacher);
}

function buildClassStart10mEmail({ staffName, slot }) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const subject = `Reminder: class starts in 10 minutes (${slot.subject || "Class"})`;
  const meet = String(slot.meet_link || "").trim() || "Not set";
  const timetableUrl = portalLink("/timetable");
  const htmlContent = renderEmailTemplate({
    title: "Class starts in 10 minutes",
    greeting: `Hi ${staffName || "Instructor"},`,
    intro: "Your class starts in 10 minutes. Use the button below to open the Meet link.",
    details: [
      { label: "Subject", value: slot.subject || "N/A" },
      { label: "Topic", value: slot.topic || "N/A" },
      { label: "When", value: whenText },
      { label: "Batch", value: slot.batch_id || "N/A" },
      { label: "Section", value: slot.section_id || "All" },
    ],
    primaryAction: meet && meet !== "Not set" ? { label: "Open Meet link", href: meet } : null,
    secondaryAction: timetableUrl ? { label: "Open timetable", href: timetableUrl, variant: "secondary" } : null,
  });
  const textContent = [
    `Hello ${staffName || "Instructor"},`,
    "Your class starts in 10 minutes.",
    `Subject: ${slot.subject || "N/A"}`,
    `Topic: ${slot.topic || "N/A"}`,
    `When: ${whenText}`,
    `Meet link: ${meet}`,
    `Batch: ${slot.batch_id || "N/A"}`,
    `Section: ${slot.section_id || "All"}`,
    timetableUrl ? `Portal: ${timetableUrl}` : null,
    `Support: ${getSupportEmail()}`,
  ].filter(Boolean).join("\n");
  return { subject, htmlContent, textContent };
}

function buildClassStart60mEmail({ staffName, slot }) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const subject = `Reminder: your class starts in 1 hour (${slot.subject || "Class"})`;
  const meet = String(slot.meet_link || "").trim();
  const timetableUrl = portalLink("/timetable");
  const htmlContent = renderEmailTemplate({
    title: "Your class starts in 1 hour",
    greeting: `Hi ${staffName || "Instructor"},`,
    intro: meet
      ? "Your class starts in about an hour. Use the button below to open the Meet link when it's time."
      : "Your class starts in about an hour. The Meet link isn't set yet — please add it in the timetable.",
    details: [
      { label: "Subject", value: slot.subject || "N/A" },
      { label: "Topic", value: slot.topic || "N/A" },
      { label: "When", value: whenText },
      { label: "Batch", value: slot.batch_id || "N/A" },
      { label: "Section", value: slot.section_id || "All" },
    ],
    primaryAction: meet ? { label: "Open Meet link", href: meet } : null,
    secondaryAction: timetableUrl ? { label: "Open timetable", href: timetableUrl, variant: "secondary" } : null,
  });
  const textContent = [
    `Hello ${staffName || "Instructor"},`,
    "Your class starts in about 1 hour.",
    `Subject: ${slot.subject || "N/A"}`,
    `Topic: ${slot.topic || "N/A"}`,
    `When: ${whenText}`,
    `Meet link: ${meet || "Not set yet — please add it in the timetable"}`,
    `Batch: ${slot.batch_id || "N/A"}`,
    `Section: ${slot.section_id || "All"}`,
    timetableUrl ? `Portal: ${timetableUrl}` : null,
    `Support: ${getSupportEmail()}`,
  ].filter(Boolean).join("\n");
  return { subject, htmlContent, textContent };
}

function buildMeetLinkUpdatedEmail({ staffName, slot }) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const subject = `Meet link updated for your class (${slot.subject || "Class"})`;
  const meet = String(slot.meet_link || "").trim();
  const timetableUrl = portalLink("/timetable");
  const htmlContent = renderEmailTemplate({
    title: "Meet link updated",
    greeting: `Hi ${staffName || "Instructor"},`,
    intro: "The Meet link for your upcoming class has changed. Please use the new link below.",
    details: [
      { label: "Subject", value: slot.subject || "N/A" },
      { label: "Topic", value: slot.topic || "N/A" },
      { label: "When", value: whenText },
      { label: "Batch", value: slot.batch_id || "N/A" },
      { label: "Section", value: slot.section_id || "All" },
    ],
    primaryAction: meet ? { label: "Open new Meet link", href: meet } : null,
    secondaryAction: timetableUrl ? { label: "Open timetable", href: timetableUrl, variant: "secondary" } : null,
  });
  const textContent = [
    `Hello ${staffName || "Instructor"},`,
    "The Meet link for your upcoming class has changed.",
    `Subject: ${slot.subject || "N/A"}`,
    `When: ${whenText}`,
    `New Meet link: ${meet || "Not set"}`,
    timetableUrl ? `Portal: ${timetableUrl}` : null,
    `Support: ${getSupportEmail()}`,
  ].filter(Boolean).join("\n");
  return { subject, htmlContent, textContent };
}

function buildResourceUploadedEmail({ staffName, slot, kind }) {
  const whenText = fmtWhenLocal(slot.class_date, slot.time);
  const isNotes = kind === "notes";
  const label = isNotes ? "Notes" : "Recording";
  const url = String(isNotes ? slot.notes_link : slot.recording_link).trim();
  const lecturesUrl = portalLink("/timetable");
  const subject = `${label} uploaded for your class: ${slot.subject || "Class"} (${whenText})`;
  const htmlContent = renderEmailTemplate({
    title: `${label} uploaded`,
    greeting: `Hi ${staffName || "Instructor"},`,
    intro: `${label} has been added for your class session.`,
    details: [
      { label: "Subject", value: slot.subject || "N/A" },
      { label: "Topic", value: slot.topic || "N/A" },
      { label: "When", value: whenText },
    ],
    primaryAction: url ? { label: `Open ${label.toLowerCase()}`, href: url } : null,
    secondaryAction: lecturesUrl ? { label: "Open timetable", href: lecturesUrl, variant: "secondary" } : null,
  });
  const textContent = [
    `Hello ${staffName || "Instructor"},`,
    `${label} has been added for your class session.`,
    `Subject: ${slot.subject || "N/A"}`,
    `Topic: ${slot.topic || "N/A"}`,
    `When: ${whenText}`,
    `Link: ${url}`,
    lecturesUrl ? `Portal: ${lecturesUrl}` : null,
    `Support: ${getSupportEmail()}`,
  ].filter(Boolean).join("\n");
  return { subject, htmlContent, textContent };
}

async function notifyInstructorsForSlot({ slot, event_type, title, message, action_url, emailBuilder }) {
  const recipients = await resolveInstructorRecipientsForSlot(slot);
  if (!recipients.length) return { notified: 0, emailed: 0 };

  let notified = 0;
  let emailed = 0;
  for (const r of recipients) {
    const dedupeKey = `${String(event_type || "event").trim()}:${String(slot?._id || "").trim()}:${String(
      r._id
    )}`;
    await emitEventNotification({
      audience: "individual",
      recipient_id: String(r._id),
      title,
      message,
      category: "alerts",
      event_type,
      action_url: action_url || "",
      dedupe_key: dedupeKey,
    });
    notified += 1;

    const toEmail = String(r.email || "").trim();
    if (emailBuilder && toEmail) {
      try {
        const mail = emailBuilder({ staff: r, slot });
        await sendSimpleEmail({ toEmail, ...mail });
        emailed += 1;
      } catch (e) {
        console.error("[INSTRUCTOR_REMINDER_EMAIL_FAILED]", e?.message || e);
      }
    }
  }

  return { notified, emailed };
}

module.exports = {
  notifyInstructorsForSlot,
  buildClassStart10mEmail,
  buildClassStart60mEmail,
  buildMeetLinkUpdatedEmail,
  buildResourceUploadedEmail,
  fmtWhenLocal,
  resolveInstructorRecipientsByName,
  resolveInstructorRecipientsForSlot,
};

