/**
 * Backfill ClassJoinAudit.batch_id (attendance) for historical join records, so per-batch
 * attendance reports work for records created before the batch_id field existed.
 *
 * Derives the batch from the joined LiveClass: legacy `batch_id` if set, else the first
 * `target_batch_ids` entry. (Historical records can't know which of a multi-target class's batches
 * the student attended as; the first target is a reasonable, documented default.)
 *
 * Safe: only $set batch_id on records that lack it; never deletes/creates. Idempotent.
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/backfill-classjoinaudit-batch-id.js            # DRY RUN (default)
 *   node src/scripts/backfill-classjoinaudit-batch-id.js --apply    # write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const ClassJoinAudit = require("../models/ClassJoinAudit");
const LiveClass = require("../models/LiveClass");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true;
}

function batchForClass(c) {
  const legacy = String(c?.batch_id || "").toLowerCase().trim();
  if (legacy) return legacy;
  const targets = (c?.target_batch_ids || []).map((b) => String(b).toLowerCase().trim()).filter(Boolean);
  return targets[0] || "";
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  await connectDb();
  console.log(`\n[CLASSJOIN_BATCH_BACKFILL] mode=${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);

  const rows = await ClassJoinAudit.find({
    $or: [{ batch_id: { $exists: false } }, { batch_id: "" }, { batch_id: null }],
  })
    .select("_id class_id batch_id")
    .lean();

  const classIds = [...new Set(rows.map((r) => String(r.class_id)))];
  const classes = await LiveClass.find({ _id: { $in: classIds } }).select("batch_id target_batch_ids").lean();
  const batchByClass = new Map(classes.map((c) => [String(c._id), batchForClass(c)]));

  let planned = 0;
  let applied = 0;
  let skipped = 0;
  for (const r of rows) {
    const bid = batchByClass.get(String(r.class_id)) || "";
    if (!bid) {
      skipped += 1;
      continue;
    }
    planned += 1;
    if (!dryRun) {
      await ClassJoinAudit.updateOne({ _id: r._id }, { $set: { batch_id: bid } });
      applied += 1;
    }
  }

  console.log(`  attendance records missing batch_id: ${rows.length}`);
  console.log(`  ${dryRun ? "would stamp" : "stamped"}: ${dryRun ? planned : applied}`);
  console.log(`  skipped (class has no batch): ${skipped}`);
  console.log(`\n[CLASSJOIN_BATCH_BACKFILL] done${dryRun ? "  (re-run with --apply to write)" : ""}\n`);

  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[CLASSJOIN_BATCH_BACKFILL_FAILED]", err);
    process.exit(1);
  });
