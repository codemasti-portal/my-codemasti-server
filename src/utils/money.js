const PAISE_PER_RUPEE = 100;

function rupeesToPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * PAISE_PER_RUPEE);
}

function paiseToRupees(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return 0;
  return n / PAISE_PER_RUPEE;
}

function formatINR(paise) {
  const rupees = paiseToRupees(paise);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: rupees % 1 === 0 ? 0 : 2,
  }).format(rupees);
}

function sumPaise(values) {
  let total = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

module.exports = {
  PAISE_PER_RUPEE,
  rupeesToPaise,
  paiseToRupees,
  formatINR,
  sumPaise,
};
