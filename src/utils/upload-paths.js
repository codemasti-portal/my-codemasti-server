const os = require("os");
const path = require("path");

/**
 * Use writable temp storage on serverless runtimes (e.g. Vercel),
 * and project-local uploads directory for local/self-hosted runs.
 */
function getUploadsRoot() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.SERVERLESS) {
    return path.join(os.tmpdir(), "uploads");
  }
  return path.join(__dirname, "..", "..", "uploads");
}

module.exports = {
  getUploadsRoot,
};

