// Student-facing payment endpoints.
//   POST /students/payments/initiate          → create Payment + return PhonePe redirect URL
//   GET  /students/payments/status/:txnId     → poll PhonePe + sync DB; used by /checkout/return page

const mongoose = require("mongoose");
const { z } = require("zod");
const { sendSuccess, sendError } = require("../utils/response");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const phonepe = require("../services/phonepe-gateway.service");

function genMerchantTxnId(invoiceId) {
  const shortInv = String(invoiceId).slice(-8);
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `INV${shortInv}${ts}${rnd}`.toUpperCase();
}

const initiateSchema = z.object({
  invoice_id: z.string().min(1),
});

/** POST /students/payments/initiate */
async function initiatePayment(req, res) {
  const sid = req.user?.sub;
  if (!mongoose.Types.ObjectId.isValid(sid)) {
    return sendError(res, 400, "INVALID_USER", "Invalid session");
  }
  const parsed = initiateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message || "Invalid body");
  }
  const { invoice_id } = parsed.data;
  if (!mongoose.Types.ObjectId.isValid(invoice_id)) {
    return sendError(res, 400, "INVALID_ID", "Invalid invoice id");
  }

  const invoice = await Invoice.findOne({ _id: invoice_id, student_id: sid });
  if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");
  if (invoice.status !== "pending") {
    return sendError(res, 409, "INVOICE_NOT_PAYABLE", `Invoice is ${invoice.status}`);
  }
  if (!Number.isFinite(invoice.total_due_paise) || invoice.total_due_paise <= 0) {
    return sendError(res, 400, "ZERO_DUE", "Invoice has no outstanding amount");
  }

  // Always create a new Payment row per attempt. PhonePe rejects reused merchantTransactionId, so
  // each retry needs a fresh id. Webhook idempotency on the invoice side prevents double-mark.
  const merchantTxnId = genMerchantTxnId(invoice._id);

  let payment;
  try {
    payment = await Payment.create({
      invoice_id: invoice._id,
      student_id: invoice.student_id,
      amount_paise: invoice.total_due_paise,
      merchant_transaction_id: merchantTxnId,
      status: "initiated",
      initiated_at: new Date(),
    });
  } catch (err) {
    return sendError(res, 500, "PAYMENT_CREATE_FAILED", err.message || "Could not create payment");
  }

  let phonepeResult;
  try {
    phonepeResult = await phonepe.initiatePayment({
      merchantTransactionId: merchantTxnId,
      amountPaise: invoice.total_due_paise,
      studentId: String(invoice.student_id),
    });
  } catch (err) {
    payment.status = "failed";
    payment.failure_reason = String(err.message || err).slice(0, 500);
    payment.completed_at = new Date();
    await payment.save();
    return sendError(res, 502, "GATEWAY_ERROR", err.message || "PhonePe initiate failed");
  }

  payment.status = "pending";
  await payment.save();

  return sendSuccess(
    res,
    {
      redirect_url: phonepeResult.redirectUrl,
      merchant_transaction_id: merchantTxnId,
      payment_id: String(payment._id),
      invoice_id: String(invoice._id),
      amount_paise: invoice.total_due_paise,
    },
    "Payment initiated"
  );
}

/** GET /students/payments/status/:merchantTxnId — sync DB by querying PhonePe if not yet final. */
async function getPaymentStatus(req, res) {
  const sid = req.user?.sub;
  if (!mongoose.Types.ObjectId.isValid(sid)) {
    return sendError(res, 400, "INVALID_USER", "Invalid session");
  }
  const merchantTxnId = String(req.params.merchantTxnId || "").trim();
  if (!merchantTxnId) {
    return sendError(res, 400, "INVALID_ID", "Missing merchantTransactionId");
  }

  const payment = await Payment.findOne({ merchant_transaction_id: merchantTxnId, student_id: sid });
  if (!payment) return sendError(res, 404, "NOT_FOUND", "Payment not found");

  // If already final, just return current state.
  const finalStates = new Set(["success", "failed", "refunded", "partially_refunded"]);
  if (!finalStates.has(payment.status)) {
    try {
      const norm = await phonepe.verifyPayment(merchantTxnId);
      if (norm.status && norm.status !== payment.status) {
        payment.status = norm.status;
        payment.phonepe_transaction_id = norm.phonepeTransactionId || payment.phonepe_transaction_id || "";
        payment.payment_method = norm.paymentMethod || payment.payment_method;
        payment.webhook_payload = payment.webhook_payload || norm.raw; // don't overwrite webhook truth
        if (norm.status === "success" || norm.status === "failed") {
          payment.completed_at = new Date();
        }
        if (norm.status === "failed") {
          payment.failure_code = norm.code || "";
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
      }
    } catch (err) {
      // Log only — fall through to return whatever DB state we have.
      console.error("[ERROR]", JSON.stringify({
        context: "PAYMENT_STATUS_VERIFY_FAIL",
        merchantTxnId,
        message: err.message,
      }));
    }
  }

  const invoice = await Invoice.findById(payment.invoice_id).lean();

  return sendSuccess(res, {
    payment: {
      id: String(payment._id),
      merchant_transaction_id: payment.merchant_transaction_id,
      phonepe_transaction_id: payment.phonepe_transaction_id || "",
      status: payment.status,
      payment_method: payment.payment_method,
      amount_paise: payment.amount_paise,
      initiated_at: payment.initiated_at,
      completed_at: payment.completed_at,
      failure_reason: payment.failure_reason || "",
    },
    invoice: invoice
      ? {
          id: String(invoice._id),
          invoice_number: invoice.invoice_number,
          status: invoice.status,
          total_due_paise: invoice.total_due_paise,
          paid_at: invoice.paid_at,
        }
      : null,
  });
}

module.exports = { initiatePayment, getPaymentStatus };
