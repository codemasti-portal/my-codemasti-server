const crypto = require("crypto");
const { sendSuccess, sendError } = require("../utils/response");
const Student = require("../models/Student");
const ReferralEvent = require("../models/ReferralEvent");
const { REFERRAL_PROGRAM_SUMMARY } = require("../utils/referralRewards");

async function me(req, res) {
  let student = await Student.findById(req.user.sub);
  if (!student) {
    return sendError(res, 404, "STUDENT_NOT_FOUND", "Student not found");
  }
  if (!student.referral_code) {
    student.referral_code = `CM-${crypto.randomBytes(4).toString("hex")}`;
    await student.save();
  }

  const base =
    process.env.REFERRAL_LINK_BASE || `${process.env.PUBLIC_APP_URL || "https://codemasti.com"}/register`;
  const link = `${base}${base.includes("?") ? "&" : "?"}ref=${encodeURIComponent(student.referral_code)}`;

  const referrals_verified_count = await Student.countDocuments({ referred_by: student._id });
  const referral_bonus_count = student.referral_bonus_count || 0;
  const total_referrals = referrals_verified_count + referral_bonus_count;
  const queue = student.referral_benefits_queue || [];
  const pending_fee_benefits = queue.map((row) => ({
    kind: row.kind,
    label: row.label || "",
    monthly_fee_discount_percent: row.monthly_fee_discount_percent,
    months: row.months ?? (row.reward_type === "merchandise" ? 0 : 1),
    granted_at: row.granted_at,
    source: row.source === "manual_admin" ? "manual_admin" : "auto",
    reward_type: row.reward_type === "merchandise" ? "merchandise" : "fee_credit",
  }));

  return sendSuccess(res, {
    code: student.referral_code,
    link,
    total_referrals,
    referrals_verified_count,
    referral_bonus_count,
    program_summary: REFERRAL_PROGRAM_SUMMARY,
    registration_fee_discount_percent: student.registration_fee_discount_percent || 0,
    pending_fee_benefits,
    rewards: pending_fee_benefits.map((b) => ({
      title: b.label,
      percent: b.monthly_fee_discount_percent,
      months: b.months,
      reward_type: b.reward_type,
    })),
  });
}

async function events(req, res) {
  const rows = await ReferralEvent.find({ student_id: req.user.sub })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  const data = rows.map((e) => ({
    id: String(e._id),
    event: e.event,
    meta: e.meta || {},
    created_at: e.createdAt,
  }));
  return sendSuccess(res, data);
}

module.exports = { me, events };
