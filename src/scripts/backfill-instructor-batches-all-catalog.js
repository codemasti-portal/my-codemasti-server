/**
 * Set every instructor's batches_assigned to ALL batch_id values currently in BatchCatalog
 * (fallback: DEFAULT_BATCHES from constants if catalog is empty).
 *
 * Use when enabling batch scoping so existing instructors keep “all batches” until you trim in UI.
 *
 * Usage (from repo root, with MONGODB_URI in .env):
 *   node src/scripts/backfill-instructor-batches-all-catalog.js --dry-run
 *   node src/scripts/backfill-instructor-batches-all-catalog.js --apply
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Staff = require("../models/Staff");
const BatchCatalog = require("../models/BatchCatalog");
const { DEFAULT_BATCHES } = require("../constants/batchDefaults");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  if (argv.includes("--dry-run")) return true;
  return true;
}

async function loadAllCatalogBatchIds() {
  const rows = await BatchCatalog.find({}).sort({ order: 1, name: 1 }).select("batch_id").lean();
  const fromDb = [...new Set(rows.map((r) => String(r.batch_id || "").trim().toLowerCase()).filter(Boolean))];
  if (fromDb.length) return fromDb;
  return DEFAULT_BATCHES.map((d) => d.batch_id).filter(Boolean);
}

async function run() {
  const argv = process.argv.slice(2);
  const dryRun = isDryRun(argv);

  await connectDb();

  const batchIds = await loadAllCatalogBatchIds();
  if (!batchIds.length) {
    console.error("No batch ids found in catalog and defaults are empty. Abort.");
    process.exitCode = 1;
    await mongoose.connection.close();
    return;
  }

  const filter = { role: "instructor" };
  const count = await Staff.countDocuments(filter);

  console.log(`Catalog batch_ids (order): ${batchIds.join(", ")}`);
  console.log(`Instructors matched: ${count}`);
  console.log(dryRun ? "[DRY RUN] No writes. Use --apply to update." : "[APPLY] Updating…");

  if (dryRun) {
    const sample = await Staff.find(filter).select("email name batches_assigned").limit(8).lean();
    if (sample.length) {
      console.log("Sample (first 8):");
      for (const s of sample) {
        console.log(`  ${s.email}  batches_assigned=${JSON.stringify(s.batches_assigned || [])}`);
      }
    }
    await mongoose.connection.close();
    return;
  }

  const result = await Staff.updateMany(filter, { $set: { batches_assigned: batchIds } });
  const modified = Number(result.modifiedCount ?? result.nModified ?? 0);
  const matched = Number(result.matchedCount ?? result.n ?? 0);
  console.log(`matchedCount: ${matched}, modifiedCount: ${modified}`);
  console.log(
    "Done. Profile completion % updates when each profile is opened in admin, or on next profile save."
  );

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("Migration failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
