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

module.exports = {
  PAISE_PER_RUPEE,
  rupeesToPaise,
  paiseToRupees,
};
