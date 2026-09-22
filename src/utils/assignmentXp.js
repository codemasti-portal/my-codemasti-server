function fullQuestionXp(xp) {
  return Math.max(0, Math.floor(Number(xp) || 0));
}

function lateXpAmount(fullXp) {
  return Math.floor(fullXp / 2);
}

/** Accepted only: full XP on/before deadline, otherwise half. */
function xpAwardedForAccepted(questionXp, submittedAt, deadlineDate) {
  const full = fullQuestionXp(questionXp);
  if (!deadlineDate) return full;
  const tSub = new Date(submittedAt).getTime();
  const tEnd = new Date(deadlineDate).getTime();
  if (Number.isNaN(tEnd)) return full;
  if (tSub <= tEnd) return full;
  return lateXpAmount(full);
}

function submittedAtOrBeforeDeadline(submittedAt, deadlineDate) {
  if (deadlineDate == null) return true;
  const tEnd = new Date(deadlineDate).getTime();
  if (Number.isNaN(tEnd)) return true;
  return new Date(submittedAt).getTime() <= tEnd;
}

module.exports = {
  fullQuestionXp,
  lateXpAmount,
  xpAwardedForAccepted,
  submittedAtOrBeforeDeadline,
};
