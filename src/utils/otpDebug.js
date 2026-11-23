// Single source of truth for "may we print an OTP to the server log?".
//
// Used when the OTP email could not be sent (Brevo unconfigured / error) so developers can still
// log in locally. Printing OTPs in production logs would let anyone with log access take over
// accounts, so the rule is:
//
//   OTP_DEBUG_LOG === "true"                          -> log (explicit opt-in, any environment)
//   OTP_DEBUG_LOG === "false"                         -> never log
//   anything else (unset/other) and NODE_ENV !== "production" -> log (local dev default)
//   anything else and NODE_ENV === "production"       -> do NOT log
//
// NODE_ENV is "production" in the Docker image, deploy/restart-container.sh, and on Vercel
// (set automatically). Local `npm run dev` has NODE_ENV unset (or "development") and keeps logging.

function shouldLogOtp(env = process.env) {
  const flag = env.OTP_DEBUG_LOG;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return env.NODE_ENV !== "production";
}

/**
 * Always log that the OTP email failed to send (no OTP value); log the OTP itself only when
 * allowed by shouldLogOtp().
 * @param {string} tag    e.g. "OTP_DEBUG" or "STAFF_OTP_DEBUG"
 * @param {Error}  error  the email send error
 * @param {string} email
 * @param {string} otp
 */
function logOtpIfAllowed(tag, error, email, otp) {
  // The send failure itself is always worth a log line; the OTP value never is unless allowed.
  console.warn(`[${tag}] OTP email send failed:`, error && error.message);
  if (!shouldLogOtp()) return false;
  console.log(`[${tag}] OTP for ${email}: ${otp}`);
  return true;
}

module.exports = { shouldLogOtp, logOtpIfAllowed };
