// Central place to read which payment flow is active and the UPI payee details.
//
//   PAYMENTS_MODE      "manual_upi" (default) | "phonepe"
//   UPI_PAYEE_VPA      e.g. 7541062514@kotak811
//   UPI_PAYEE_NAME     e.g. Monu Kumar
//
// Flip PAYMENTS_MODE to "phonepe" once my.codemasti.com is whitelisted, with no code changes.

function getPaymentsMode() {
  const v = String(process.env.PAYMENTS_MODE || "manual_upi").toLowerCase().trim();
  return v === "phonepe" ? "phonepe" : "manual_upi";
}

function getUpiConfig() {
  return {
    vpa: String(process.env.UPI_PAYEE_VPA || "7541062514@kotak811").trim(),
    payee_name: String(process.env.UPI_PAYEE_NAME || "Monu Kumar").trim(),
  };
}

module.exports = { getPaymentsMode, getUpiConfig };
