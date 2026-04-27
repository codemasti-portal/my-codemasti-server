/**
 * Match Assignment documents whose batch_id equals a catalog batch_id after trim + lowercase.
 * Legacy rows with missing or empty batch_id do not match any non-empty batch id.
 */
function assignmentMatchesCatalogBatchId(normalizedBatchId) {
  const bid = String(normalizedBatchId || "").trim().toLowerCase();
  if (!bid) return null;
  return {
    $expr: {
      $eq: [{ $toLower: { $trim: { input: { $ifNull: ["$batch_id", ""] } } } }, bid],
    },
  };
}

/**
 * Same visibility as student assignment list for a catalog program: released (release_date <= now)
 * and either legacy global (no batch) or batch_id matches the program (trim + case-insensitive).
 */
function assignmentVisibleToCatalogBatchCountFilter(normalizedBatchId, now = new Date()) {
  const bid = String(normalizedBatchId || "").trim().toLowerCase();
  if (!bid) return null;
  const published = { release_date: { $lte: now } };
  const scope = {
    $or: [
      { batch_id: { $exists: false } },
      { batch_id: "" },
      {
        $expr: {
          $eq: [{ $toLower: { $trim: { input: { $ifNull: ["$batch_id", ""] } } } }, bid],
        },
      },
    ],
  };
  return { $and: [published, scope] };
}

module.exports = {
  assignmentMatchesCatalogBatchId,
  assignmentVisibleToCatalogBatchCountFilter,
};
