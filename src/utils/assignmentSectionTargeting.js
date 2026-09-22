/**
 * Per-batch section targeting for Assignment documents.
 *
 * Canonical stored shape (one Assignment row per catalog batch):
 *   section_ids: []            → all sections in that batch
 *   section_ids: ["core", ...] → only those catalog section ids
 *
 * Legacy rows may only have section_id (single string). Empty section_id also means all sections.
 */

function normSectionId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function normBatchId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function uniqueSectionIds(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const sid = normSectionId(raw);
    if (!sid) continue;
    if (seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
  }
  return out;
}

/**
 * Effective targeted section ids for eligibility / notifications.
 * Empty array = all sections in the assignment's batch (not "no access").
 */
function effectiveAssignmentSectionIds(assignment) {
  const fromArray = uniqueSectionIds(assignment?.section_ids);
  if (fromArray.length) return fromArray;
  const one = normSectionId(assignment?.section_id);
  return one ? [one] : [];
}

function isAllSectionsTargeting(assignment) {
  return effectiveAssignmentSectionIds(assignment).length === 0;
}

/**
 * Fields to persist on an Assignment for a given explicit section list.
 * Empty list → all sections (clears legacy section_id).
 */
function sectionFieldsToStore(sectionIds) {
  const ids = uniqueSectionIds(sectionIds);
  return {
    section_ids: ids,
    section_id: ids[0] || "",
  };
}

/**
 * Resolve create payload into one target per batch.
 *
 * Preferred: body.batch_targets = [{ batch_id, section_ids? }]
 * Legacy:    body.batch_ids / body.batch_id + optional section_id / section_ids
 *            (legacy section list is copied onto every selected batch — same as today's UI).
 *
 * @returns {{ ok: true, targets: Array<{ batch_id: string, section_ids: string[] }> } | { ok: false, code: string, message: string }}
 */
function resolveAssignmentCreateTargets(body) {
  const rawTargets = Array.isArray(body?.batch_targets) ? body.batch_targets : null;
  if (rawTargets && rawTargets.length) {
    const targets = [];
    const seen = new Set();
    for (const row of rawTargets) {
      const batch_id = normBatchId(row?.batch_id);
      if (!batch_id) {
        return { ok: false, code: "BATCH_REQUIRED", message: "Each batch target must include a batch_id." };
      }
      if (seen.has(batch_id)) {
        return {
          ok: false,
          code: "DUPLICATE_BATCH_TARGET",
          message: `Batch "${batch_id}" is listed more than once. Combine its sections into a single target.`,
        };
      }
      seen.add(batch_id);
      targets.push({
        batch_id,
        section_ids: uniqueSectionIds(row?.section_ids),
      });
    }
    return { ok: true, targets };
  }

  let batchIds = Array.isArray(body?.batch_ids) ? body.batch_ids.map(normBatchId).filter(Boolean) : [];
  if (!batchIds.length && body?.batch_id) {
    const one = normBatchId(body.batch_id);
    if (one) batchIds = [one];
  }
  if (!batchIds.length) {
    return { ok: false, code: "BATCH_REQUIRED", message: "At least one batch must be selected." };
  }
  const seen = new Set();
  const deduped = [];
  for (const bid of batchIds) {
    if (seen.has(bid)) continue;
    seen.add(bid);
    deduped.push(bid);
  }
  const fromArray = uniqueSectionIds(body?.section_ids);
  const fromOne = normSectionId(body?.section_id);
  const section_ids = fromArray.length ? fromArray : fromOne ? [fromOne] : [];
  return {
    ok: true,
    targets: deduped.map((batch_id) => ({ batch_id, section_ids })),
  };
}

/**
 * Validate section ids against a BatchCatalog.sections list (or equivalent).
 * Unknown batch / unknown section is a hard error — never coerced to all-sections.
 *
 * @param {string[]} sectionIds already normalized
 * @param {{ sections?: Array<{ section_id?: string }> } | null} catalogDoc
 */
function validateSectionsForCatalog(batchId, sectionIds, catalogDoc) {
  const bid = normBatchId(batchId);
  if (!bid) {
    return { ok: false, code: "BATCH_REQUIRED", message: "batch_id is required." };
  }
  if (!catalogDoc) {
    return { ok: false, code: "UNKNOWN_BATCH", message: `Unknown batch: ${bid}` };
  }
  const ids = uniqueSectionIds(sectionIds);
  if (!ids.length) return { ok: true, section_ids: [] };

  const allowed = new Set(
    (catalogDoc.sections || []).map((s) => normSectionId(s?.section_id)).filter(Boolean)
  );
  const unknown = ids.filter((sid) => !allowed.has(sid));
  if (unknown.length) {
    return {
      ok: false,
      code: "INVALID_SECTION",
      message: `Section${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "does" : "do"} not belong to batch "${bid}".`,
    };
  }
  return { ok: true, section_ids: ids };
}

module.exports = {
  normSectionId,
  normBatchId,
  uniqueSectionIds,
  effectiveAssignmentSectionIds,
  isAllSectionsTargeting,
  sectionFieldsToStore,
  resolveAssignmentCreateTargets,
  validateSectionsForCatalog,
};
