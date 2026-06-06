/**
 * Backfill StudentEnrollment.roll_number for existing enrollments (decision #7b: per-batch roll numbers).
 *
 * Today every student has a single (primary) active enrollment, so this stamps that enrollment's
 * roll_number = the student's enrollment_number (their existing roll). Secondary-batch enrollments
 * created later via add-batch auto-generate their own roll numbers, so this script only fixes history.
 *
 * Safe: only $set roll_number on active enrollments that lack it AND whose batch matches the student's
 * enrollment_number-derived (primary) batch. Never deletes/creates. Idempotent. Non-primary
 * enrollments (rare/none today) are reported and skipped (assign via add-batch / admin).
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/backfill-enrollment-roll-number.js            # DRY RUN (default)
 *   node src/scripts/backfill-enrollment-roll-number.js --apply    # write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Student = require("../models/Student");
const StudentEnrollment = require("../models/StudentEnrollment");
const { parseEnrollmentNumber, deriveStudentBatchFromEnrollment } = require("../utils/enrollment");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true;
}

function primaryBatchFor(student) {
  if (!student?.enrollment_number) return "";
  try {
    return String(deriveStudentBatchFromEnrollment(parseEnrollmentNumber(student.enrollment_number)).batch_id || "").toLowerCase();
  } catch {
    return "";
  }
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  await connectDb();
  console.log(`\n[ENROLLMENT_ROLL_BACKFILL] mode=${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);

  const rows = await StudentEnrollment.find({
    status: "active",
    $or: [{ roll_number: { $exists: false } }, { roll_number: "" }, { roll_number: null }],
  })
    .select("_id student_id batch_id roll_number")
    .lean();

  const studentIds = [...new Set(rows.map((r) => String(r.student_id)))];
  const students = await Student.find({ _id: { $in: studentIds } }).select("_id enrollment_number").lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));

  let stamped = 0;
  let skippedNonPrimary = 0;
  for (const e of rows) {
    const s = byId.get(String(e.student_id));
    const primary = primaryBatchFor(s);
    const eBatch = String(e.batch_id || "").toLowerCase().trim();
    if (s?.enrollment_number && primary && eBatch === primary) {
      if (!dryRun) await StudentEnrollment.updateOne({ _id: e._id }, { $set: { roll_number: s.enrollment_number } });
      stamped += 1;
    } else {
      skippedNonPrimary += 1; // secondary batch / no enrollment_number → assign via add-batch or admin
    }
  }

  console.log(`  active enrollments missing roll_number: ${rows.length}`);
  console.log(`  ${dryRun ? "would stamp (primary = enrollment_number)" : "stamped"}: ${stamped}`);
  console.log(`  skipped (non-primary / no enrollment_number): ${skippedNonPrimary}`);
  console.log(`\n[ENROLLMENT_ROLL_BACKFILL] done${dryRun ? "  (re-run with --apply to write)" : ""}\n`);

  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ENROLLMENT_ROLL_BACKFILL_FAILED]", err);
    process.exit(1);
  });
