/**
 * Central definitions for milestone achievements (beyond monthly leaderboard trophies).
 * Titles/description copy is mirrored on the profile when awards are persisted.
 */

/** Distinct Arena quests solved (accepted) — batch-catalog questions only. */
const ARENA_QUEST_MILESTONES = [
  { code: "arena_quests_10", at: 10, title: "Arena newcomer", description: "Solved 10 distinct Arena quests." },
  { code: "arena_quests_25", at: 25, title: "Arena explorer", description: "Solved 25 distinct Arena quests." },
  { code: "arena_quests_50", at: 50, title: "Arena regular", description: "Solved 50 distinct Arena quests." },
  { code: "arena_quests_100", at: 100, title: "Arena veteran", description: "Solved 100 distinct Arena quests." },
  { code: "arena_quests_200", at: 200, title: "Arena marathoner", description: "Solved 200 distinct Arena quests." },
  { code: "arena_quests_300", at: 300, title: "Arena legend", description: "Solved 300 distinct Arena quests." },
];

/**
 * Best-ever IST-calendar-day streak with ≥1 Accepted Arena submission (batch-catalog questions).
 * “Best” avoids losing badges after a streak breaks (same philosophy as leaderboard best streak UX).
 */
const ARENA_STREAK_BEST_MILESTONES = [
  { code: "arena_best_streak_7", days: 7, title: "Arena week streak", description: "Seven IST days in a row with Arena progress." },
  { code: "arena_best_streak_14", days: 14, title: "Arena fortnight streak", description: "14 IST days in a row with Arena progress." },
  { code: "arena_best_streak_25", days: 25, title: "Arena 25-day streak", description: "25 IST calendar days—best-ever Arena streak." },
  { code: "arena_best_streak_50", days: 50, title: "Arena 50-day streak", description: "50 IST calendar days—best-ever Arena streak." },
  { code: "arena_best_streak_100", days: 100, title: "Arena 100-day streak", description: "100 IST calendar days—best-ever Arena streak." },
];

module.exports = {
  ARENA_QUEST_MILESTONES,
  ARENA_STREAK_BEST_MILESTONES,
};
