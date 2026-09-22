/**
 * Match Assignment documents whose batch_id equals a catalog batch_id after trim + lowercase.
 * Legacy rows with missing or empty batch_id do not match any non-empty batch id.
 */
function assignmentMatchesCatalogBatchId(normalizedBatchId) {
  const bid = String(normalizedBatchId || "").trim().toLowerCase();
  if (!bid) return null;
  return {
    $or: [
      {
        $expr: {
          $eq: [{ $toLower: { $trim: { input: { $ifNull: ["$batch_id", ""] } } } }, bid],
        },
      },
      {
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$batch_ids", []] },
                  as: "bb",
                  cond: {
                    $eq: [
                      bid,
                      { $toLower: { $trim: { input: { $toString: "$$bb" } } } },
                    ],
                  },
                },
              },
            },
            0,
          ],
        },
      },
    ],
  };
}

/**
 * $or branches: student (or admin progress) can see this assignment for the given catalog batch key
 * when combined with published filter — mirrors arena-style `batch_ids` plus legacy global rows.
 */
function assignmentCatalogBatchScopeOr(normalizedBatchId) {
  const b = String(normalizedBatchId || "").trim().toLowerCase();
  if (!b) return [];
  return [
    { batch_id: { $exists: false } },
    { batch_id: "" },
    {
      $expr: {
        $eq: [{ $toLower: { $trim: { input: { $ifNull: ["$batch_id", ""] } } } }, b],
      },
    },
    {
      $expr: {
        $gt: [
          {
            $size: {
              $filter: {
                input: { $ifNull: ["$batch_ids", []] },
                as: "bb",
                cond: {
                  $eq: [
                    b,
                    { $toLower: { $trim: { input: { $toString: "$$bb" } } } },
                  ],
                },
              },
            },
          },
          0,
        ],
      },
    },
  ];
}

/** Published assignments visible to a catalog program (or all programs if batch key is empty). */
function assignmentPublishedVisibleToCatalogBatch(batchKey, now = new Date()) {
  const published = { release_date: { $lte: now } };
  const notDraftProject = { $nor: [{ assignment_type: "project", project_published: false }] };
  const b = String(batchKey || "").trim().toLowerCase();
  if (!b) return { $and: [published, notDraftProject] };
  return {
    $and: [published, notDraftProject, { $or: assignmentCatalogBatchScopeOr(b) }],
  };
}

/**
 * Same visibility as student assignment list for a catalog program: released (release_date <= now)
 * and either legacy global (no batch) or batch_id / batch_ids matches the program (trim + case-insensitive).
 */
function assignmentVisibleToCatalogBatchCountFilter(normalizedBatchId, now = new Date()) {
  const bid = String(normalizedBatchId || "").trim().toLowerCase();
  if (!bid) return null;
  return assignmentPublishedVisibleToCatalogBatch(bid, now);
}

/**
 * Plain-object checks for lean Assignment docs (must match Mongo visibility + student list semantics).
 * Empty batchKey = any catalog / legacy “see all published” grouping.
 */
function assignmentBatchKeysOnDoc(assignment) {
  const keys = [];
  const primary = String(assignment?.batch_id ?? "").toLowerCase().trim();
  if (primary) keys.push(primary);
  for (const x of Array.isArray(assignment?.batch_ids) ? assignment.batch_ids : []) {
    const z = String(x ?? "").toLowerCase().trim();
    if (z) keys.push(z);
  }
  return [...new Set(keys)];
}

function assignmentDocMatchesCatalogBatch(assignment, batchKey) {
  const b = String(batchKey || "").trim().toLowerCase();
  if (!b) return true;
  const keys = assignmentBatchKeysOnDoc(assignment);
  if (keys.length === 0) return true;
  return keys.includes(b);
}

function assignmentDocIsPublished(assignment, now = new Date()) {
  const t = new Date(assignment?.release_date).getTime();
  if (Number.isNaN(t)) return false;
  if (t > now.getTime()) return false;
  if (String(assignment?.assignment_type || "").toLowerCase() === "project" && assignment?.project_published === false) {
    return false;
  }
  return true;
}

module.exports = {
  assignmentMatchesCatalogBatchId,
  assignmentCatalogBatchScopeOr,
  assignmentPublishedVisibleToCatalogBatch,
  assignmentVisibleToCatalogBatchCountFilter,
  assignmentBatchKeysOnDoc,
  assignmentDocMatchesCatalogBatch,
  assignmentDocIsPublished,
};
