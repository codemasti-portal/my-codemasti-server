/**
 * Batch catalog registry — the single, data-driven source for batch metadata that used to be
 * hardcoded across the codebase (PREFIX_TO_BATCH, DISPLAY_BATCH_BY_CATALOG_ID, BATCH tier maps,
 * staff-doubts defaultBatchIds, reassign-batch z.enum, etc.).
 *
 * Design (Phase 0 — additive, backward compatible):
 *   - SEED holds the three legacy batches with their EXACT current values, so every synchronous
 *     reader behaves byte-identically to the old hardcoded maps even before the DB is backfilled
 *     or the registry has refreshed.
 *   - refresh() reads BatchCatalog and OVERLAYS the DB over the seed (DB wins where it has a value;
 *     seed fills gaps). New batches created in admin appear automatically — no code change.
 *   - Synchronous readers use the in-memory snapshot. They never block and never throw; a stale
 *     read at worst misses a brand-new batch for up to TTL_MS, then self-heals.
 *   - Callers that mutate the catalog (create/update/remove batch) should `await refresh(true)`.
 *
 * No DB writes happen here. The model is required lazily so importing this never opens a connection.
 */

const SEED_LIST = [
  { batch_id: "spark", name: "Spark", order: 0, enrollment_prefix: "S", tier_label: "Beginner", is_protected: true, is_active: true, include_in_default_views: true },
  { batch_id: "builders", name: "Builders", order: 1, enrollment_prefix: "B", tier_label: "Intermediate", is_protected: true, is_active: true, include_in_default_views: true },
  { batch_id: "innovators", name: "Innovators", order: 2, enrollment_prefix: "I", tier_label: "Advanced", is_protected: true, is_active: true, include_in_default_views: true },
];

const TTL_MS = 60_000;

function norm(id) {
  return String(id || "").trim().toLowerCase();
}

function buildSeedById() {
  const byId = {};
  for (const b of SEED_LIST) byId[b.batch_id] = { ...b };
  return byId;
}

function rebuild(byId) {
  const byPrefix = {};
  for (const b of Object.values(byId)) {
    const p = String(b.enrollment_prefix || "").trim().toUpperCase();
    if (p) byPrefix[p] = b.batch_id;
  }
  return { byId, byPrefix };
}

// Snapshot is always valid from first import (seeded). DB overlay replaces it on refresh.
let snapshot = rebuild(buildSeedById());
let lastLoadedAt = 0;
let inFlight = null;

function mergeRow(base, db) {
  // base = seed entry (or a synthesized default for a brand-new batch); db = lean BatchCatalog doc.
  const out = { ...base };
  if (db.name != null) out.name = db.name;
  if (db.order != null) out.order = db.order;
  if (typeof db.enrollment_prefix === "string" && db.enrollment_prefix.trim()) {
    out.enrollment_prefix = db.enrollment_prefix.trim().toUpperCase();
  }
  if (db.tier_label != null) out.tier_label = db.tier_label;
  if (db.is_protected !== undefined) out.is_protected = !!db.is_protected;
  if (db.is_active !== undefined) out.is_active = !!db.is_active;
  if (db.include_in_default_views !== undefined) out.include_in_default_views = !!db.include_in_default_views;
  return out;
}

async function refresh(force = false) {
  if (!force && Date.now() - lastLoadedAt < TTL_MS) return snapshot;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const BatchCatalog = require("../models/BatchCatalog");
      const rows = await BatchCatalog.find({})
        .select("batch_id name order enrollment_prefix tier_label is_protected is_active include_in_default_views")
        .lean();
      const byId = buildSeedById();
      for (const r of rows) {
        const id = norm(r.batch_id);
        if (!id) continue;
        const base =
          byId[id] || {
            batch_id: id,
            name: r.name || id,
            order: r.order ?? 0,
            enrollment_prefix: "",
            tier_label: "",
            is_protected: false,
            is_active: true,
            include_in_default_views: true,
          };
        byId[id] = mergeRow(base, r);
      }
      snapshot = rebuild(byId);
      lastLoadedAt = Date.now();
    } catch (err) {
      // Keep the last good (or seed) snapshot; never break a request over a registry refresh.
      console.error("[BATCH_REGISTRY_REFRESH_FAILED]", err?.message || err);
    } finally {
      inFlight = null;
    }
    return snapshot;
  })();
  return inFlight;
}

/** Non-blocking: trigger a background refresh if the snapshot is stale. Safe to call from sync readers. */
function maybeRefresh() {
  if (Date.now() - lastLoadedAt >= TTL_MS && !inFlight) {
    refresh().catch(() => {});
  }
}

// ---- Synchronous readers (snapshot-backed; seeded so always usable) ----

function getBatchSync(batchId) {
  maybeRefresh();
  return snapshot.byId[norm(batchId)] || null;
}

/** Display label for a batch_id (replaces DISPLAY_BATCH_BY_CATALOG_ID). Falls back to the id itself. */
function displayNameSync(batchId) {
  const b = getBatchSync(batchId);
  return b ? b.name : "";
}

/** Enrollment letter → batch_id (replaces CATALOG_BATCH_ID_TO_PREFIX inverse / prefix lookups). */
function prefixToBatchIdSync(letter) {
  maybeRefresh();
  const p = String(letter || "").trim().toUpperCase();
  return p ? snapshot.byPrefix[p] || "" : "";
}

/** Enrollment letter → display name (replaces PREFIX_TO_BATCH[letter]). */
function prefixToDisplayNameSync(letter) {
  const id = prefixToBatchIdSync(letter);
  return id ? displayNameSync(id) : "";
}

/** batch_id → enrollment letter (replaces PROGRAM_BATCH_TO_PREFIX / CATALOG_BATCH_ID_TO_PREFIX). */
function batchIdToPrefixSync(batchId) {
  const b = getBatchSync(batchId);
  return b ? String(b.enrollment_prefix || "").toUpperCase() : "";
}

function tierLabelSync(batchId) {
  const b = getBatchSync(batchId);
  return b ? b.tier_label || "" : "";
}

function isProtectedSync(batchId) {
  const b = getBatchSync(batchId);
  return !!(b && b.is_protected);
}

/** All enrollment letters currently mapped to a batch (for relaxed enrollment_number validation). */
function knownPrefixesSync() {
  maybeRefresh();
  return Object.keys(snapshot.byPrefix);
}

/** batch_ids flagged for "all default batches" views (replaces staff-doubts defaultBatchIds). */
function defaultViewBatchIdsSync() {
  maybeRefresh();
  return Object.values(snapshot.byId)
    .filter((b) => b.is_active !== false && b.include_in_default_views !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => b.batch_id);
}

/** Is this a known, active batch_id? (replaces z.enum membership checks). */
function isKnownBatchIdSync(batchId, { activeOnly = true } = {}) {
  const b = getBatchSync(batchId);
  if (!b) return false;
  return activeOnly ? b.is_active !== false : true;
}

function allBatchIdsSync({ activeOnly = true } = {}) {
  maybeRefresh();
  return Object.values(snapshot.byId)
    .filter((b) => (activeOnly ? b.is_active !== false : true))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => b.batch_id);
}

module.exports = {
  refresh,
  maybeRefresh,
  getBatchSync,
  displayNameSync,
  prefixToBatchIdSync,
  prefixToDisplayNameSync,
  batchIdToPrefixSync,
  tierLabelSync,
  isProtectedSync,
  knownPrefixesSync,
  defaultViewBatchIdsSync,
  isKnownBatchIdSync,
  allBatchIdsSync,
  // exposed for tests / explicit seeding
  SEED_LIST,
};
