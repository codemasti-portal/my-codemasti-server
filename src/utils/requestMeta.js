function pickIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0].trim();
  }
  if (Array.isArray(xf) && xf.length) {
    return String(xf[0] || "").trim();
  }
  return (
    req.ip ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    ""
  );
}

function pickUserAgent(req) {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : "";
}

function buildLoginMeta(req) {
  const ip = String(pickIp(req) || "").trim();
  const userAgent = String(pickUserAgent(req) || "").trim();
  return {
    last_login_at: new Date(),
    last_login_ip: ip.slice(0, 80),
    last_login_user_agent: userAgent,
  };
}

module.exports = {
  buildLoginMeta,
};

