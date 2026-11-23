// PhonePe S2S webhook endpoint (v2 PG API).
// Mounted in app.js BEFORE express.json so we have raw access to body + headers.
//
// v2 payload shape:
//   {
//     "event": "checkout.order.completed" | "checkout.order.failed"
//            | "pg.refund.accepted" | "pg.refund.completed" | "pg.refund.failed",
//     "payload": { merchantOrderId | merchantRefundId, state, amount, paymentDetails[...], ... }
//   }
//
// Auth: PhonePe sends Authorization: <hex> where hex = SHA256("username:password"). We verify
// against PHONEPE_WEBHOOK_USERNAME/PASSWORD env vars.
//
// If those env vars are NOT set the header cannot be checked, so the body is untrusted: before any
// state change (payment status, invoice paid, refund status) the event is re-confirmed with
// PhonePe's own order/refund status API (verifyPayment / verifyRefund). Status call failed -> 503
// (PhonePe retries); status disagrees with the webhook -> 409 and nothing is changed.
// When the env vars ARE set, behaviour is unchanged (signature check only, body trusted).

const { sendError } = require("../utils/response");
const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const Refund = require("../models/Refund");
const gateway = require("../services/phonepe-gateway.service");
const { verifyWebhookSignature, normalizeProviderResponse } = gateway;

// Webhook refund `state` -> internal status (same mapping verifyRefund applies to the status API).
function refundStateToStatus(state) {
  const up = String(state || "").toUpperCase();
  if (up === "COMPLETED" || up === "CONFIRMED") return "success";
  if (up === "FAILED") return "failed";
  return "pending";
}

/**
 * Used only when webhook credentials are not configured. Asks PhonePe for the real order state.
 * Returns { ok: true, norm } (norm taken from PhonePe's answer, not from the request body) or
 * { ok: false, status, code, message } describing the HTTP response to send.
 */
async function confirmPaymentWithGateway(merchantTxnId, claimedStatus) {
  let verified;
  try {
    verified = await gateway.verifyPayment(merchantTxnId);
  } catch (err) {
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_CONFIRM_FAIL",
      merchantTxnId,
      message: err.message,
    }));
    return { ok: false, status: 503, code: "CONFIRMATION_UNAVAILABLE", message: "Could not confirm order with PhonePe" };
  }
  const idMismatch = verified.merchantOrderId && verified.merchantOrderId !== merchantTxnId;
  if (idMismatch || verified.status !== claimedStatus) {
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_CONFIRM_MISMATCH",
      merchantTxnId,
      claimed: claimedStatus,
      confirmed: verified.status,
      idMismatch: Boolean(idMismatch),
    }));
    return { ok: false, status: 409, code: "WEBHOOK_UNCONFIRMED", message: "Webhook does not match PhonePe order status" };
  }
  return { ok: true, norm: verified };
}

async function confirmRefundWithGateway(merchantRefundId, claimedStatus) {
  let verified;
  try {
    verified = await gateway.verifyRefund(merchantRefundId);
  } catch (err) {
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_CONFIRM_FAIL",
      merchantRefundId,
      message: err.message,
    }));
    return { ok: false, status: 503, code: "CONFIRMATION_UNAVAILABLE", message: "Could not confirm refund with PhonePe" };
  }
  if (verified.status !== claimedStatus) {
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_CONFIRM_MISMATCH",
      merchantRefundId,
      claimed: claimedStatus,
      confirmed: verified.status,
    }));
    return { ok: false, status: 409, code: "WEBHOOK_UNCONFIRMED", message: "Webhook does not match PhonePe refund status" };
  }
  return { ok: true };
}

function decodeRequestBody(rawBuffer) {
  try {
    const txt = Buffer.isBuffer(rawBuffer) ? rawBuffer.toString("utf8") : String(rawBuffer || "");
    if (!txt.trim()) return {};
    return JSON.parse(txt);
  } catch (e) {
    return { __decode_error: e.message };
  }
}

async function handlePhonepeWebhook(req, res) {
  const sigOk = verifyWebhookSignature(req.headers);
  if (!sigOk) {
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_SIG_FAIL",
      headers: { authorization: req.headers?.authorization ? "(present)" : "(missing)" },
    }));
    return sendError(res, 401, "UNAUTHORIZED", "Invalid webhook signature");
  }

  const payload = decodeRequestBody(req.body);
  if (payload.__decode_error) {
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_DECODE_FAIL",
      message: payload.__decode_error,
    }));
    return sendError(res, 400, "INVALID_PAYLOAD", "Could not decode webhook body");
  }

  // v2: route by `event` field (preferred per docs; the `type` field is being deprecated).
  // Refund events use merchantRefundId; payment events use merchantOrderId.
  const event = String(payload?.event || "").toLowerCase();
  const isRefundEvent = event.startsWith("pg.refund.");

  if (isRefundEvent) {
    const refundId = payload?.payload?.merchantRefundId;
    if (!refundId) return sendError(res, 400, "MISSING_REFUND_ID", "merchantRefundId not present in payload");
    const refund = await Refund.findOne({ merchant_refund_id: refundId });
    if (!refund) {
      console.error("[ERROR]", JSON.stringify({ context: "PHONEPE_WEBHOOK_UNKNOWN_REFUND", refundId }));
      return res.status(200).json({ success: true, data: { ignored: true } });
    }
    if (!gateway.isWebhookAuthConfigured()) {
      const claimed = refundStateToStatus(payload?.payload?.state);
      const check = await confirmRefundWithGateway(refundId, claimed);
      if (!check.ok) return sendError(res, check.status, check.code, check.message);
    }
    return handleRefundWebhook(req, res, refund, payload);
  }

  // Payment event (or unknown — fall through and try merchantOrderId)
  const merchantTxnId =
    payload?.payload?.merchantOrderId ||
    payload?.payload?.merchantTransactionId || // legacy / safety
    payload?.merchantOrderId;
  if (!merchantTxnId) {
    return sendError(res, 400, "MISSING_TXN_ID", "merchantOrderId not present in payload");
  }

  const payment = await Payment.findOne({ merchant_transaction_id: merchantTxnId });
  if (!payment) {
    // Unknown id — log and 200 so PhonePe stops retrying.
    console.error("[ERROR]", JSON.stringify({
      context: "PHONEPE_WEBHOOK_UNKNOWN_ID",
      merchantTxnId,
    }));
    return res.status(200).json({ success: true, data: { ignored: true } });
  }

  let norm = normalizeProviderResponse(payload);
  // Without webhook credentials the body is unauthenticated: never store it, only PhonePe's answer.
  const bodyIsTrusted = gateway.isWebhookAuthConfigured();
  let storedPayload = payload;

  if (!bodyIsTrusted) {
    // Already processed with this status: nothing to confirm or write, and no outbound call.
    if (payment.status === norm.status && payment.webhook_received_at) {
      return res.status(200).json({ success: true, data: { duplicate: true } });
    }
    // Confirm with PhonePe and use ITS data.
    const check = await confirmPaymentWithGateway(merchantTxnId, norm.status);
    if (!check.ok) return sendError(res, check.status, check.code, check.message);
    norm = check.norm;
    storedPayload = check.norm.raw || {};
  }

  // Idempotency: if status hasn't changed, just record the webhook receipt and exit.
  if (payment.status === norm.status && payment.webhook_received_at) {
    payment.webhook_payload = storedPayload;
    payment.webhook_received_at = new Date();
    await payment.save();
    return res.status(200).json({ success: true, data: { duplicate: true } });
  }

  payment.status = norm.status;
  payment.phonepe_transaction_id = norm.phonepeTransactionId || payment.phonepe_transaction_id || "";
  payment.payment_method = norm.paymentMethod || payment.payment_method;
  payment.webhook_payload = storedPayload;
  payment.webhook_received_at = new Date();
  if (norm.status === "success" || norm.status === "failed") {
    payment.completed_at = new Date();
  }
  if (norm.status === "failed") {
    payment.failure_code = norm.code || "";
    payment.failure_reason = bodyIsTrusted
      ? payload?.payload?.errorContext?.detailedErrorCode || payload?.payload?.message || ""
      : String(norm.code || "");
  }
  await payment.save();

  if (norm.status === "success") {
    const invoice = await Invoice.findById(payment.invoice_id);
    if (invoice && invoice.status !== "paid") {
      invoice.status = "paid";
      invoice.paid_at = new Date();
      invoice.paid_payment_id = payment._id;
      await invoice.save();
    }
  }

  return res.status(200).json({ success: true, data: { processed: true } });
}

async function handleRefundWebhook(req, res, refund, payload) {
  const norm = normalizeProviderResponse(payload);
  // Map back to refund-domain status set.
  const next =
    norm.status === "success" ? "success" :
    norm.status === "failed" ? "failed" :
    norm.status === "pending" ? "pending" :
    refund.status;

  // Idempotency: if status hasn't changed, store payload + ack.
  if (refund.status === next && refund.webhook_received_at) {
    refund.webhook_payload = payload;
    refund.webhook_received_at = new Date();
    await refund.save();
    return res.status(200).json({ success: true, data: { duplicate: true } });
  }

  refund.status = next;
  refund.webhook_payload = payload;
  refund.webhook_received_at = new Date();
  if (next === "success" || next === "failed") {
    refund.completed_at = new Date();
  }
  await refund.save();

  // On failure, roll back the optimistic Payment.refunded_paise + Invoice state we applied at initiation.
  if (next === "failed") {
    const payment = await Payment.findById(refund.payment_id);
    if (payment) {
      payment.refunded_paise = Math.max(0, (payment.refunded_paise || 0) - refund.amount_paise);
      payment.status = payment.refunded_paise > 0 ? "partially_refunded" : "success";
      await payment.save();
    }
    const invoice = await Invoice.findById(refund.invoice_id);
    if (invoice) {
      invoice.refunded_paise = Math.max(0, (invoice.refunded_paise || 0) - refund.amount_paise);
      if (invoice.refunded_paise === 0) invoice.status = "paid";
      else if (invoice.refunded_paise < invoice.total_due_paise) invoice.status = "partially_refunded";
      await invoice.save();
    }
  }
  // On success, the optimistic state set at initiation remains correct — nothing extra to do.

  return res.status(200).json({ success: true, data: { refund_processed: true } });
}

module.exports = { handlePhonepeWebhook };
