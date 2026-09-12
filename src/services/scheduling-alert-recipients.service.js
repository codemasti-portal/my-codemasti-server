const Staff = require("../models/Staff");
const { SCHEDULING_ALERT_ELIGIBLE_ROLES } = require("../utils/scheduling-alerts");
const { ROLES } = require("../utils/rbac");
const { sendSimpleEmail } = require("./brevo");
const { emitEventNotification } = require("./staffPanelNotification.service");

const RECIPIENT_SELECT = "_id name email role";

/**
 * Resolve operational scheduling-alert recipients (missing Meet link, etc.).
 *
 * 1. Active admin/super_admin staff with receives_scheduling_alerts=true
 * 2. If none configured, fall back to all active super_admin staff (never empty)
 *
 * @returns {Promise<{ recipients: Array, usedFallback: boolean }>}
 */
async function resolveSchedulingAlertRecipients() {
  const configured = await Staff.find({
    role: { $in: SCHEDULING_ALERT_ELIGIBLE_ROLES },
    is_active: true,
    receives_scheduling_alerts: true,
  })
    .select(RECIPIENT_SELECT)
    .lean();

  if (configured.length) {
    return { recipients: configured, usedFallback: false };
  }

  console.warn(
    "[SCHEDULING_ALERT_RECIPIENTS] No configured scheduling-alert recipients; falling back to active super_admin staff"
  );

  const fallback = await Staff.find({
    role: ROLES.SUPER_ADMIN,
    is_active: true,
  })
    .select(RECIPIENT_SELECT)
    .lean();

  return { recipients: fallback, usedFallback: true };
}

/**
 * Deliver an operational scheduling alert to individually resolved recipients (panel + optional email).
 *
 * @param {{
 *   event_type: string,
 *   dedupeKeyPrefix: string,
 *   title: string,
 *   panelMessage: string,
 *   action_url?: string,
 *   email?: { subject: string, htmlContent: string, textContent: string } | ((recipient: object) => { subject: string, htmlContent: string, textContent: string }),
 * }} opts
 * @returns {Promise<{ ok: boolean, notified: number, emailed: number, usedFallback: boolean }>}
 */
async function notifySchedulingAlertRecipients(opts) {
  const { recipients, usedFallback } = await resolveSchedulingAlertRecipients();

  if (!recipients.length) {
    console.error(
      "[SCHEDULING_ALERT_DELIVERY] No scheduling-alert recipients available (configured list empty and super_admin fallback empty)"
    );
    return { ok: false, notified: 0, emailed: 0, usedFallback };
  }

  const {
    event_type,
    dedupeKeyPrefix,
    title,
    panelMessage,
    action_url = "",
    email = null,
  } = opts;

  let notified = 0;
  let emailed = 0;

  for (const recipient of recipients) {
    const recipientId = String(recipient._id);
    await emitEventNotification({
      audience: "individual",
      recipient_id: recipientId,
      title,
      message: panelMessage,
      category: "alerts",
      event_type,
      action_url,
      dedupe_key: `${dedupeKeyPrefix}:${recipientId}`,
    });
    notified += 1;

    const toEmail = String(recipient.email || "").trim();
    if (!toEmail || !email) continue;

    const mail = typeof email === "function" ? email(recipient) : email;
    if (!mail?.subject) continue;

    try {
      await sendSimpleEmail({
        toEmail,
        subject: mail.subject,
        htmlContent: mail.htmlContent,
        textContent: mail.textContent,
      });
      emailed += 1;
    } catch (e) {
      console.error("[SCHEDULING_ALERT_EMAIL_FAILED]", recipientId, e?.message || e);
    }
  }

  return { ok: notified > 0, notified, emailed, usedFallback };
}

module.exports = { resolveSchedulingAlertRecipients, notifySchedulingAlertRecipients };
