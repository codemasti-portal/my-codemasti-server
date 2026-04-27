// Brevo (Sendinblue) integration for transactional emails.
// Docs: https://developers.brevo.com/
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

function getSender() {
  const email = process.env.BREVO_SENDER_EMAIL;
  const name = process.env.BREVO_SENDER_NAME || "CodeMasti";
  if (!email) throw new Error("BREVO_SENDER_EMAIL is not set");
  return { email, name };
}

async function sendTransactionalEmail({ toEmail, templateId, params }) {
  const apiKey = process.env.BREVO_API_KEY;
  const sender = getSender();

  if (!apiKey) {
    throw new Error("Brevo not configured: set BREVO_API_KEY");
  }
  if (!templateId) {
    throw new Error("Brevo template send: set BREVO_TEMPLATE_ID");
  }

  const res = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender,
      to: [{ email: toEmail }],
      templateId: Number(templateId),
      params,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Brevo email send failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
}

/**
 * Send a one-off transactional email (no Brevo template). Used for OTP when BREVO_TEMPLATE_ID is unset.
 */
async function sendSimpleEmail({ toEmail, subject, htmlContent, textContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  const sender = getSender();
  if (!apiKey) {
    throw new Error("Brevo not configured: set BREVO_API_KEY");
  }

  const body = {
    sender,
    to: [{ email: toEmail }],
    subject,
  };
  if (htmlContent) body.htmlContent = htmlContent;
  if (textContent) body.textContent = textContent;

  const res = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Brevo email send failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
}

async function sendOtpEmail({ toEmail, otp, expiresInSec }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) {
    throw new Error("Brevo not configured: set BREVO_API_KEY and BREVO_SENDER_EMAIL");
  }

  const templateId = process.env.BREVO_TEMPLATE_ID;
  if (templateId) {
    await sendTransactionalEmail({
      toEmail,
      templateId,
      params: {
        otp,
        expiresInSec: String(expiresInSec),
      },
    });
    return;
  }

  const subject = process.env.BREVO_OTP_SUBJECT || "Your CodeMasti login code";
  const brand = process.env.BREVO_SENDER_NAME || "CodeMasti";
  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
  <p>Hi,</p>
  <p>Your ${brand} login code is:</p>
  <p style="font-size: 1.75rem; font-weight: 700; letter-spacing: 0.25em; margin: 1rem 0;">${otp}</p>
  <p>This code expires in <strong>${expiresInSec}</strong> seconds. Do not share it with anyone.</p>
  <p style="color: #666; font-size: 0.875rem;">If you did not request this, you can ignore this email.</p>
</body>
</html>`.trim();
  const textContent = `Your ${brand} login code is: ${otp}. It expires in ${expiresInSec} seconds. Do not share this code.`;

  await sendSimpleEmail({ toEmail, subject, htmlContent, textContent });
}

module.exports = { sendOtpEmail, sendTransactionalEmail, sendSimpleEmail };
