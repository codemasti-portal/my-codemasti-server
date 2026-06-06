/**
 * Phase 2 (stamping only): set StudentEnrollment.batch_id from each enrollment's
 * Course.linked_batch_id, for existing rows that don't have it yet.
 *
 * Why it's safe:
 *   - Touches ONLY StudentEnrollment; `$set` only the denormalized `batch_id`.
 *   - Never creates, deletes, completes, or cancels any enrollment — so it cannot
 *     spawn invoices, change billing, or collapse anyone's membership.
 *   - Idempotent — re-running is a no-op once batch_id matches the course.
 *   - Going forward, the StudentEnrollment pre-save hook keeps new rows in sync automatically;
 *     this only fixes pre-existing rows.
 *
 * NOTE: this deliberately does NOT do the "gap-fill" (creating a missing enrollment for a
 * legacy student who has a batch_id/enrollment_number but no active enrollment). That step
 * creates a billable object and must be run only behind the billing dry-run diff gate
 * (see BATCH_MULTIBATCH_MIGRATION_PLAN.md §10 RISK 1). It is intentionally out of scope here.
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/backfill-enrollment-batch-id.js            # default = DRY RUN (no writes)
 *   node src/scripts/backfill-enrollment-batch-id.js --dry-run  # explicit dry run
 *   node src/scripts/backfill-enrollment-batch-id.js --apply    # actually write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true; // default + --dry-run
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  await connectDb();
  console.log(`\n[ENROLLMENT_BATCH_ID_BACKFILL] mode=${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);

  // Map course_id -> linked_batch_id (normalized).
  const courses = await Course.find({}).select("_id linked_batch_id").lean();
  const batchByCourse = new Map(
    courses.map((c) => [String(c._id), String(c.linked_batch_id || "").toLowerCase().trim()])
  );

  // Only rows that still need stamping: empty/missing batch_id but their course has a linked batch.
  const rows = await StudentEnrollment.find({
    $or: [{ batch_id: { $exists: false } }, { batch_id: "" }, { batch_id: null }],
  })
    .select("_id course_id status batch_id")
    .lean();

  let planned = 0;
  let applied = 0;
  let skippedNoCourseBatch = 0;

  for (const e of rows) {
    const want = batchByCourse.get(String(e.course_id));
    if (!want) {
      skippedNoCourseBatch += 1;
      continue; // course not batch-linked → nothing to stamp
    }
    planned += 1;
    if (!dryRun) {
      await StudentEnrollment.updateOne({ _id: e._id }, { $set: { batch_id: want } });
      applied += 1;
    }
  }

  console.log(`  candidates needing batch_id: ${rows.length}`);
  console.log(`  ${dryRun ? "would stamp" : "stamped"}: ${dryRun ? planned : applied}`);
  console.log(`  skipped (course has no linked_batch_id): ${skippedNoCourseBatch}`);
  console.log(`\n[ENROLLMENT_BATCH_ID_BACKFILL] done${dryRun ? "  (re-run with --apply to write)" : ""}\n`);

  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ENROLLMENT_BATCH_ID_BACKFILL_FAILED]", err);
    process.exit(1);
  });
