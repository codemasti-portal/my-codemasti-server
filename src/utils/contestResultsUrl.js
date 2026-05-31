function getContestResultsBaseUrl() {
  return (
    String(process.env.CONTEST_RESULTS_BASE_URL || "https://counsellor.codemasti.com/result").trim() ||
    "https://counsellor.codemasti.com/result"
  );
}

function buildContestResultsUrl(cstRegistrationId) {
  const cst = String(cstRegistrationId || "").trim();
  if (!cst) return null;
  const base = getContestResultsBaseUrl();
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}cst=${encodeURIComponent(cst)}`;
}

module.exports = { getContestResultsBaseUrl, buildContestResultsUrl };
