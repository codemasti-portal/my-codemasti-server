/**
 * Contest visibility phases for student portal.
 * highlight = distinct dashboard styling while contest is visible and still running.
 */

function getContestPhase(contest, now = new Date()) {
  if (!contest || !contest.is_published) {
    return { phase: "hidden", highlight: false, cta: null };
  }

  const showFrom = new Date(contest.show_from).getTime();
  const startAt = new Date(contest.start_at).getTime();
  const endAt = new Date(contest.end_at).getTime();
  const nowT = now.getTime();

  if (Number.isNaN(showFrom) || Number.isNaN(startAt) || Number.isNaN(endAt)) {
    return { phase: "hidden", highlight: false, cta: null };
  }

  if (nowT < showFrom) {
    return { phase: "hidden", highlight: false, cta: null };
  }

  if (nowT < startAt) {
    return { phase: "upcoming", highlight: true, cta: "opens_soon" };
  }

  if (nowT < endAt) {
    return { phase: "live", highlight: true, cta: "join" };
  }

  return { phase: "results", highlight: false, cta: "results" };
}

function countdownSeconds(contest, now = new Date()) {
  const { phase } = getContestPhase(contest, now);
  const nowT = now.getTime();
  if (phase === "upcoming") {
    return Math.max(0, Math.floor((new Date(contest.start_at).getTime() - nowT) / 1000));
  }
  if (phase === "live") {
    return Math.max(0, Math.floor((new Date(contest.end_at).getTime() - nowT) / 1000));
  }
  return 0;
}

module.exports = { getContestPhase, countdownSeconds };
