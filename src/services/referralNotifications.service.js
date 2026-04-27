const Notification = require("../models/Notification");
const { REFEREE_REGISTRATION_DISCOUNT_PERCENT } = require("../utils/referralRewards");
const staffPanelSvc = require("./staffPanelNotification.service");

function buildReferrerBody(newStudentName, newCount, queueEntries) {
  const name = String(newStudentName || "A student").trim();
  const lines = [
    `${name} joined using your referral code.`,
    `Successful referrals: ${newCount}.`,
    "",
    "New rewards queued:",
  ];
  for (const e of queueEntries || []) {
    if (e.reward_type === "merchandise") {
      lines.push(`• ${e.label || e.kind} (merchandise)`);
    } else {
      const pct = e.monthly_fee_discount_percent ?? 0;
      const mo = e.months ?? 1;
      lines.push(`• ${e.label || e.kind} (${pct}% × ${mo} mo.)`);
    }
  }
  lines.push("");
  lines.push("Open Refer and earn in the sidebar to copy your link or see your full queue.");
  return lines.join("\n");
}

/**
 * In-app notifications for referrer + referee, plus staff panel ping for admins.
 * Errors are logged only — never throws to callers.
 */
async function notifyReferralAdmissionSuccess({
  referrerId,
  newStudentId,
  newStudentName,
  referrerDisplayName,
  newCount,
  queueEntries,
}) {
  const admissionRefId = `referral:admission:${String(newStudentId)}`;
  const welcomeRefId = `referral:welcome:${String(newStudentId)}`;

  try {
    await Notification.create({
      student_id: referrerId,
      type: "system",
      title: "Refer and earn — you earned new rewards",
      body: buildReferrerBody(newStudentName, newCount, queueEntries),
      read_at: null,
      ref_id: admissionRefId,
    });
  } catch (e) {
    console.warn("[referralNotifications] referrer notification", e.message || e);
  }

  try {
    await Notification.create({
      student_id: newStudentId,
      type: "system",
      title: "Refer and earn — welcome discount",
      body: `You joined with a friend’s referral code. Your registration fee includes ${REFEREE_REGISTRATION_DISCOUNT_PERCENT}% off. Share your own link anytime from Refer and earn in the sidebar.`,
      read_at: null,
      ref_id: welcomeRefId,
    });
  } catch (e) {
    console.warn("[referralNotifications] referee notification", e.message || e);
  }

  try {
    const refName = String(referrerDisplayName || "Referrer").trim();
    const stuName = String(newStudentName || "New student").trim();
    await staffPanelSvc.emitEventNotification({
      title: "Refer and earn — new admission",
      message: `${stuName} enrolled using ${refName}’s referral code. Referrer now has ${newCount} successful referral(s); ${(queueEntries || []).length} reward line(s) queued.`,
      category: "system",
      audience: "role",
      target_roles: ["admin", "super_admin"],
      event_type: "referral_admission",
    });
  } catch (e) {
    console.warn("[referralNotifications] staff panel", e.message || e);
  }
}

module.exports = { notifyReferralAdmissionSuccess };
