// PhonePe Payment Gateway — Standard Checkout v2 (OAuth-based).
// Docs: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference
//
// Flow: server fetches OAuth access token (cached) → POST /checkout/v2/pay → returns hosted-checkout
// redirect URL → student pays on PhonePe → webhook + redirect back.
//
// Differences from the older v1 API:
//   - OAuth (client_id/client_secret/client_version) instead of X-VERIFY salt-key signature
//   - Authorization scheme is "O-Bearer <token>" (NOT plain "Bearer")
//   - Sandbox base path differs from prod for OAuth specifically
//   - Response shape is a flat envelope, not wrapped in `data`
//   - Identifier is `merchantOrderId` (was `merchantTransactionId`)

const crypto = require("crypto");

const SANDBOX_BASE = "https://api-preprod.phonepe.com/apis/pg-sandbox";
const PROD_PG_BASE = "https://api.phonepe.com/apis/pg";
const PROD_OAUTH_BASE = "https://api.phonepe.com/apis/identity-manager";

function isSandbox() {
  // PHONEPE_SANDBOX is a boolean flag; default true (safer for misconfig)
  const v = String(process.env.PHONEPE_SANDBOX ?? "true").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "no";
}

function getConfig() {
  const clientId = process.env.PHONEPE_CLIENT_ID;
  const clientSecret = process.env.PHONEPE_CLIENT_SECRET;
  const clientVersion = String(process.env.PHONEPE_CLIENT_VERSION || "1");
  if (!clientId || !clientSecret) {
    throw new Error("PhonePe not configured: set PHONEPE_CLIENT_ID and PHONEPE_CLIENT_SECRET");
  }
  const sandbox = isSandbox();
  // In sandbox everything lives under /apis/pg-sandbox; in prod OAuth lives under /apis/identity-manager
  // while payment APIs live under /apis/pg.
  const oauthBase = sandbox ? SANDBOX_BASE : PROD_OAUTH_BASE;
  const pgBase = sandbox ? SANDBOX_BASE : PROD_PG_BASE;
  return { clientId, clientSecret, clientVersion, sandbox, oauthBase, pgBase };
}

function getRedirectBase() {
  return process.env.PHONEPE_REDIRECT_URL_BASE || "http://localhost:3000/checkout/return";
}

// --- OAuth token caching ---------------------------------------------------

// Module-level cache. Token is invalidated 60s before its actual expiry as a safety margin.
const TOKEN_SAFETY_MARGIN_SEC = 60;
let cachedToken = null; // { accessToken: string, tokenType: string, expiresAtSec: number }
let pendingTokenFetch = null; // Promise — coalesces concurrent fetches

async function fetchAccessToken() {
  const { clientId, clientSecret, clientVersion, oauthBase } = getConfig();
  const url = `${oauthBase}/v1/oauth/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    client_version: clientVersion,
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const msg = json?.message || json?.errorCode || `HTTP ${res.status}`;
    throw new Error(`PhonePe OAuth failed: ${msg}`);
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type || "O-Bearer",
    // expires_at is a Unix epoch in seconds per docs
    expiresAtSec: Number(json.expires_at) || Math.floor(Date.now() / 1000) + Number(json.expires_in || 1800),
  };
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAtSec - TOKEN_SAFETY_MARGIN_SEC > now) {
    return cachedToken;
  }
  if (pendingTokenFetch) {
    return pendingTokenFetch;
  }
  pendingTokenFetch = (async () => {
    try {
      cachedToken = await fetchAccessToken();
      return cachedToken;
    } finally {
      pendingTokenFetch = null;
    }
  })();
  return pendingTokenFetch;
}

async function authHeader() {
  const t = await getAccessToken();
  // Per v2 docs: Authorization: O-Bearer <token> (NOT "Bearer")
  return `${t.tokenType || "O-Bearer"} ${t.accessToken}`;
}

// --- Pay --------------------------------------------------------------------

/**
 * Initiate a Standard Checkout payment (hosted redirect flow).
 * Kept signature backward-compatible with the v1 implementation so callers don't change.
 *
 * @param {object} args
 * @param {string} args.merchantTransactionId  Our DB-side unique id (used as merchantOrderId)
 * @param {number} args.amountPaise            Integer paise (≥100)
 * @param {string} args.studentId              For our own logging / metaInfo
 * @param {string} [args.redirectUrl]          Optional override
 * @returns {Promise<{ redirectUrl: string, merchantTransactionId: string, providerResponse: object }>}
 */
async function initiatePayment({ merchantTransactionId, amountPaise, studentId, redirectUrl }) {
  const { pgBase } = getConfig();
  if (!merchantTransactionId) throw new Error("merchantTransactionId required");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    throw new Error("amountPaise must be a positive number");
  }

  const finalRedirect =
    redirectUrl ||
    `${getRedirectBase()}?merchantTransactionId=${encodeURIComponent(merchantTransactionId)}`;

  const payload = {
    merchantOrderId: merchantTransactionId,
    amount: Math.round(amountPaise),
    expireAfter: 1200, // 20 min — student has this long to complete the hosted checkout
    metaInfo: studentId ? { udf1: String(studentId) } : undefined,
    paymentFlow: {
      type: "PG_CHECKOUT",
      merchantUrls: { redirectUrl: finalRedirect },
    },
  };

  const auth = await authHeader();
  const res = await fetch(`${pgBase}/checkout/v2/pay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.redirectUrl) {
    const msg = json?.message || json?.code || json?.errorCode || `HTTP ${res.status}`;
    throw new Error(`PhonePe initiate failed: ${msg}`);
  }

  return {
    redirectUrl: json.redirectUrl,
    merchantTransactionId,
    providerResponse: json,
  };
}

// --- Status -----------------------------------------------------------------

async function verifyPayment(merchantTransactionId) {
  const { pgBase } = getConfig();
  const url = `${pgBase}/checkout/v2/order/${encodeURIComponent(merchantTransactionId)}/status?details=true&errorContext=true`;
  const auth = await authHeader();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      accept: "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.code || `HTTP ${res.status}`;
    throw new Error(`PhonePe status failed: ${msg}`);
  }
  return normalizeProviderResponse(json);
}

/**
 * Map PhonePe v2 order-status / webhook payload to our internal Payment.status shape.
 * Accepts either the raw order-status response OR a webhook's `payload` field
 * (they share the same structure).
 */
function normalizeProviderResponse(json) {
  // Webhook payloads wrap the order in `.payload`; status calls return it at the top level.
  const order = json?.payload && (json.payload.merchantOrderId || json.payload.orderId)
    ? json.payload
    : json || {};
  const state = String(order?.state || "").toUpperCase();

  const latestPayment =
    Array.isArray(order?.paymentDetails) && order.paymentDetails.length
      ? order.paymentDetails[order.paymentDetails.length - 1]
      : null;

  let status = "pending";
  if (state === "COMPLETED") status = "success";
  else if (state === "FAILED") status = "failed";
  else status = "pending";

  return {
    status,
    state,
    code: order?.errorCode || latestPayment?.errorCode || "",
    phonepeTransactionId: latestPayment?.transactionId || order?.orderId || "",
    paymentMethod: mapPaymentMode(latestPayment?.paymentMode || latestPayment?.instrument?.type),
    merchantOrderId: order?.merchantOrderId || "",
    raw: json,
  };
}

function mapPaymentMode(t) {
  const up = String(t || "").toUpperCase();
  if (up.startsWith("UPI") || up === "ACCOUNT") return "UPI";
  if (up === "CARD" || up.endsWith("_CARD") || up === "CREDIT_CARD" || up === "DEBIT_CARD") return "CARD";
  if (up === "NET_BANKING" || up === "NETBANKING") return "NETBANKING";
  if (up === "WALLET") return "WALLET";
  return "OTHER";
}

// --- Refund -----------------------------------------------------------------

async function initiateRefund({ originalMerchantTransactionId, merchantRefundId, amountPaise }) {
  const { pgBase } = getConfig();
  if (!originalMerchantTransactionId) throw new Error("originalMerchantTransactionId required");
  if (!merchantRefundId) throw new Error("merchantRefundId required");
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    throw new Error("amountPaise must be a positive number");
  }

  const payload = {
    merchantRefundId,
    originalMerchantOrderId: originalMerchantTransactionId,
    amount: Math.round(amountPaise),
  };

  const auth = await authHeader();
  const res = await fetch(`${pgBase}/payments/v2/refund`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.code || `HTTP ${res.status}`;
    throw new Error(`PhonePe refund failed: ${msg}`);
  }
  return { providerResponse: json };
}

async function verifyRefund(merchantRefundId) {
  const { pgBase } = getConfig();
  const url = `${pgBase}/payments/v2/refund/${encodeURIComponent(merchantRefundId)}/status`;
  const auth = await authHeader();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      accept: "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.code || `HTTP ${res.status}`;
    throw new Error(`PhonePe refund status failed: ${msg}`);
  }
  const state = String(json?.state || "").toUpperCase();
  let status = "pending";
  if (state === "COMPLETED" || state === "CONFIRMED") status = "success";
  else if (state === "FAILED") status = "failed";
  return { status, state, raw: json };
}

// --- Webhook signature ------------------------------------------------------

/**
 * v2 webhook authentication: PhonePe sends `Authorization: <hex>` where
 * <hex> = lowercase SHA256("username:password"). Username/password are configured
 * in the merchant dashboard and mirrored in env vars on our side.
 *
 * If env vars aren't configured, this function returns true with a one-time warn —
 * caller is opting out of webhook auth (acceptable for dev, dangerous for prod).
 */
let warnedAboutWebhookAuth = false;
function verifyWebhookSignature(headers) {
  const username = process.env.PHONEPE_WEBHOOK_USERNAME || "";
  const password = process.env.PHONEPE_WEBHOOK_PASSWORD || "";

  if (!username || !password) {
    if (!warnedAboutWebhookAuth) {
      console.warn(
        "[WARN] PhonePe webhook auth DISABLED — set PHONEPE_WEBHOOK_USERNAME + PHONEPE_WEBHOOK_PASSWORD " +
          "(matching values configured in PhonePe dashboard) to verify webhook authenticity in production."
      );
      warnedAboutWebhookAuth = true;
    }
    return true; // skip verification — dev-mode opt-out
  }

  const auth = headers?.authorization || headers?.Authorization;
  if (!auth) return false;
  const expected = crypto.createHash("sha256").update(`${username}:${password}`).digest("hex");
  return String(auth).trim().toLowerCase() === expected.toLowerCase();
}

module.exports = {
  initiatePayment,
  verifyPayment,
  verifyRefund,
  verifyWebhookSignature,
  initiateRefund,
  normalizeProviderResponse,
};
