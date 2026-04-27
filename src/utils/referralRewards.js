/**
 * Refer & earn — policy helpers (queue is applied manually / future billing integration).
 * Referee: 10% off registration when admitted with a valid student referral code.
 * Referrer: +30% off next month’s fee per successful admission, plus milestone grants.
 */

const REFEREE_REGISTRATION_DISCOUNT_PERCENT = 10;
const PER_REFERRAL_MONTHLY_FEE_EXTRA_PERCENT = 30;

/** Human-readable program copy for APIs / UI. */
const REFERRAL_PROGRAM_SUMMARY = [
  "New student (referee): 10% off registration fee when they join using a friend’s referral code.",
  "Referrer: +30% additional discount on the next month’s course fee for each successful admission you bring.",
  "2 successful referrals: 70% off one month’s fee (milestone).",
  "3 successful referrals: 100% scholarship (fee waiver) for one month.",
  "5 successful referrals: 100% scholarship for two months plus official CodeMasti merchandise (collect from centre; shipping may be arranged by the office).",
  "After 5, every 2 additional successful referrals adds one more month at 100% scholarship (7 → +1 month, 9 → +1, …).",
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function milestoneGrantsAfterCount(newTotalReferrals) {
  const grants = [];
  if (newTotalReferrals === 2) {
    grants.push({
      kind: "MILESTONE_2",
      label: "2 successful referrals — 70% off one month’s fee",
      monthly_fee_discount_percent: 70,
      months: 1,
      reward_type: "fee_credit",
    });
  }
  if (newTotalReferrals === 3) {
    grants.push({
      kind: "MILESTONE_3",
      label: "3 successful referrals — 100% scholarship for one month",
      monthly_fee_discount_percent: 100,
      months: 1,
      reward_type: "fee_credit",
    });
  }
  if (newTotalReferrals === 5) {
    grants.push({
      kind: "MILESTONE_5",
      label: "5 successful referrals — 100% scholarship for two months",
      monthly_fee_discount_percent: 100,
      months: 2,
      reward_type: "fee_credit",
    });
    grants.push({
      kind: "MILESTONE_5_MERCH",
      label:
        "5 successful referrals — CodeMasti merchandise gift (collect from centre; shipping arranged by office where applicable)",
      monthly_fee_discount_percent: 0,
      months: 0,
      reward_type: "merchandise",
    });
  }
  if (newTotalReferrals >= 7 && (newTotalReferrals - 5) % 2 === 0) {
    /* 7, 9, 11, … each add +1 month at 100% (5 already handled two months). */
    grants.push({
      kind: "MILESTONE_EXT",
      label: `${newTotalReferrals} successful referrals — +1 month at 100% scholarship`,
      monthly_fee_discount_percent: 100,
      months: 1,
      reward_type: "fee_credit",
    });
  }
  return grants;
}

function buildQueueEntries(fromStudentId, newTotalReferrals) {
  const from = fromStudentId;
  const at = new Date();
  const entries = [
    {
      kind: "PER_REFERRAL_NEXT_MONTH",
      label: "+30% additional discount on next month’s fee (per admission)",
      monthly_fee_discount_percent: PER_REFERRAL_MONTHLY_FEE_EXTRA_PERCENT,
      months: 1,
      from_student_id: from,
      granted_at: at,
      source: "auto",
      reward_type: "fee_credit",
    },
  ];
  for (const g of milestoneGrantsAfterCount(newTotalReferrals)) {
    entries.push({
      kind: g.kind,
      label: g.label,
      monthly_fee_discount_percent: g.monthly_fee_discount_percent,
      months: g.months,
      from_student_id: from,
      granted_at: at,
      source: "auto",
      reward_type: g.reward_type || "fee_credit",
    });
  }
  return entries;
}

module.exports = {
  REFEREE_REGISTRATION_DISCOUNT_PERCENT,
  PER_REFERRAL_MONTHLY_FEE_EXTRA_PERCENT,
  REFERRAL_PROGRAM_SUMMARY,
  escapeRegex,
  milestoneGrantsAfterCount,
  buildQueueEntries,
};
