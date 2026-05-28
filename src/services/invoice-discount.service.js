// Pure logic for invoice discount calculation. No DB writes here — caller persists.
//
// Order of application:
//   1. registration discount (first invoice for the student-on-this-course only)
//   2. referral fee credit (consumes one item from Student.referral_benefits_queue)
//   3. scholarship (from latest ScorecardEntry in the linked batch within the invoice period)
//   4. admin manual_adjustment (set after invoice generation, not here)

function pctOf(percent, paise) {
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.round((paise * p) / 100);
}

/**
 * Compute the discount breakdown for an invoice.
 *
 * @param {object} args
 * @param {object} args.student            — { registration_fee_discount_percent, referral_benefits_queue }
 * @param {object} args.course             — { linked_batch_id }  (for scholarship lookup)
 * @param {number} args.subtotalPaise      — pre-discount amount
 * @param {boolean} args.isFirstInvoiceForCourse — apply registration discount only on first invoice
 * @param {object|null} args.activeReferralCredit — one item from referral_benefits_queue to consume, or null
 * @param {object|null} args.scholarshipEntry     — { scholarship_amount_paise?, scholarship_percent? } or null
 * @returns {{ registration_paise, referral_paise, scholarship_paise, total_due_paise, consumed_referral_index }}
 */
function computeDiscounts({
  student,
  subtotalPaise,
  isFirstInvoiceForCourse,
  activeReferralCredit,
  scholarshipEntry,
}) {
  const subtotal = Math.max(0, Math.round(Number(subtotalPaise) || 0));

  const regPct = isFirstInvoiceForCourse ? Number(student?.registration_fee_discount_percent || 0) : 0;
  const registration_paise = pctOf(regPct, subtotal);

  let referral_paise = 0;
  if (activeReferralCredit && activeReferralCredit.reward_type === "fee_credit") {
    const refPct = Number(activeReferralCredit.monthly_fee_discount_percent || 0);
    referral_paise = pctOf(refPct, subtotal);
  }

  let scholarship_paise = 0;
  if (scholarshipEntry) {
    const amt = Number(scholarshipEntry.scholarship_amount_paise || 0);
    if (amt > 0) {
      scholarship_paise = Math.round(amt);
    } else {
      const pct = Number(scholarshipEntry.scholarship_percent || 0);
      scholarship_paise = pctOf(pct, subtotal);
    }
  }

  const total_due_paise = Math.max(0, subtotal - registration_paise - referral_paise - scholarship_paise);

  return {
    registration_paise,
    referral_paise,
    scholarship_paise,
    total_due_paise,
  };
}

/**
 * Pick the next consumable referral credit from a Student.referral_benefits_queue.
 * Returns the entry (or null) and its index in the queue so the caller can decrement/pop.
 */
function nextConsumableReferralCredit(queue) {
  if (!Array.isArray(queue)) return { entry: null, index: -1 };
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (!item) continue;
    if (item.reward_type !== "fee_credit") continue;
    if (!Number.isFinite(Number(item.months)) || Number(item.months) <= 0) continue;
    if (!Number.isFinite(Number(item.monthly_fee_discount_percent))) continue;
    return { entry: item, index: i };
  }
  return { entry: null, index: -1 };
}

module.exports = {
  computeDiscounts,
  nextConsumableReferralCredit,
  pctOf,
};
