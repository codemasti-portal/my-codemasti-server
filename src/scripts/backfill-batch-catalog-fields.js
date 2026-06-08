/**
 * Phase 0 backfill: populate the new, additive BatchCatalog columns
 * (enrollment_prefix, tier_label, is_protected, is_active, include_in_default_views)
 * on EXISTING batch rows. New rows created after the Phase 0 deploy already get these via
 * the model defaults / ensureDefaultBatches, so this only fixes pre-existing documents.
 *
 * Why it's safe:
 *   - Touches ONLY the BatchCatalog collection (a handful of system rows) — never students,
 *     enrollments, payments, invoices, or any content.
 *   - $set only the new metadata fields; never deletes, never edits batch_id/name/order/sections.
 *   - Idempotent — re-running is a no-op once values match.
 *   - Until this runs, the in-process batch-catalog-registry already serves the correct values
 *     for Spark/Builders/Innovators from its seed, so the app behaves correctly even before backfill.
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/backfill-batch-catalog-fields.js            # default = DRY RUN (no writes)
 *   node src/scripts/backfill-batch-catalog-fields.js --dry-run  # explicit dry run
 *   node src/scripts/backfill-batch-catalog-fields.js --apply    # actually write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const BatchCatalog = require("../models/BatchCatalog");
const { DEFAULT_BATCHES } = require("../constants/batchDefaults");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true; // default + --dry-run
}

/** Desired metadata for the three seeded system batches. */
const SEED_META = Object.fromEntries(
  DEFAULT_BATCHES.map((d) => [
    d.batch_id,
    {
      enrollment_prefix: (d.enrollment_prefix || "").toUpperCase(),
      tier_label: d.tier_label || "",
      is_protected: d.is_protected === true,
      is_active: true,
      include_in_default_views: d.include_in_default_views !== false,
    },
  ])
);

/** Compute the minimal $set needed to bring a row up to the desired field set (only missing/differing keys). */
function diffForRow(row, desired) {
  const set = {};
  for (const [k, want] of Object.entries(desired)) {
    const cur = row[k];
    if (cur === undefined || cur !== want) set[k] = want;
  }
  return set;
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  await connectDb();
  console.log(`\n[BATCH_CATALOG_BACKFILL] mode=${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);

  const rows = await BatchCatalog.find({}).lean();
  let planned = 0;
  let applied = 0;

  for (const row of rows) {
    // Seeded batches get their canonical metadata; any other (admin-created) row only gets
    // is_active defaulted to true if it's missing — never assume a prefix/tier for custom batches.
    const desired = SEED_META[row.batch_id] || {};
    if (!SEED_META[row.batch_id]) {
      if (row.is_active === undefined) desired.is_active = true;
      if (row.include_in_default_views === undefined) desired.include_in_default_views = true;
    }
    if (!Object.keys(desired).length) continue;

    const set = diffForRow(row, desired);
    if (!Object.keys(set).length) continue;

    planned += 1;
    console.log(`  ${row.batch_id}: ${JSON.stringify(set)}`);
    if (!dryRun) {
      await BatchCatalog.updateOne({ _id: row._id }, { $set: set });
      applied += 1;
    }
  }

  console.log(
    `\n[BATCH_CATALOG_BACKFILL] ${dryRun ? "would update" : "updated"} ${dryRun ? planned : applied} row(s)` +
      `${dryRun ? "  (re-run with --apply to write)" : ""}\n`
  );

  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[BATCH_CATALOG_BACKFILL_FAILED]", err);
    process.exit(1);
  });
