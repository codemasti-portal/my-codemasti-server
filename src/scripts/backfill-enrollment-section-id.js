/**
 * Phase 2 (section stamping): set StudentEnrollment.section_id from the student's legacy section,
 * so section-scoped rosters/cohorts work under pure `enrollment` mode (BATCH_MEMBERSHIP_SOURCE=enrollment).
 *
 * Legacy section semantics (catalogBatchStudentFilter): a student belongs to a section via
 * Student.section_id, or — when that's empty — via the enrollment_section parsed from enrollment_number.
 * This stamps `section = Student.section_id || enrollment_section` onto each active enrollment that
 * has no section_id yet, reproducing legacy matching once reads switch to enrollment.
 *
 * Why it's safe:
 *   - Touches ONLY StudentEnrollment.section_id; never creates/deletes/completes anything, never
 *     touches students/invoices/payments.
 *   - Idempotent (only fills empty section_id; re-running is a no-op once set).
 *   - Multi-batch nuance: a student's single legacy section is applied to all their active
 *     enrollments. Per-batch sections (different section per batch) are an admin refinement afterwards.
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/backfill-enrollment-section-id.js            # default = DRY RUN (no writes)
 *   node src/scripts/backfill-enrollment-section-id.js --apply    # actually write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Student = require("../models/Student");
const StudentEnrollment = require("../models/StudentEnrollment");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true;
}

function legacySectionForStudent(s) {
  const sectionId = String(s?.section_id || "").trim().toLowerCase();
  if (sectionId) return sectionId;
  return String(s?.enrollment_section || "").trim().toLowerCase();
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  await connectDb();
  console.log(`\n[ENROLLMENT_SECTION_BACKFILL] mode=${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);

  // Active enrollments missing a section_id.
  const rows = await StudentEnrollment.find({
    status: "active",
    $or: [{ section_id: { $exists: false } }, { section_id: "" }, { section_id: null }],
  })
    .select("_id student_id section_id")
    .lean();

  const studentIds = [...new Set(rows.map((r) => String(r.student_id)))];
  const students = await Student.find({ _id: { $in: studentIds } })
    .select("_id section_id enrollment_section")
    .lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));

  let planned = 0;
  let applied = 0;
  let skippedNoSection = 0;

  for (const e of rows) {
    const s = byId.get(String(e.student_id));
    const section = s ? legacySectionForStudent(s) : "";
    if (!section) {
      skippedNoSection += 1;
      continue;
    }
    planned += 1;
    if (!dryRun) {
      await StudentEnrollment.updateOne({ _id: e._id }, { $set: { section_id: section } });
      applied += 1;
    }
  }

  console.log(`  active enrollments missing section_id: ${rows.length}`);
  console.log(`  ${dryRun ? "would stamp" : "stamped"}: ${dryRun ? planned : applied}`);
  console.log(`  skipped (student has no legacy section): ${skippedNoSection}`);
  console.log(`\n[ENROLLMENT_SECTION_BACKFILL] done${dryRun ? "  (re-run with --apply to write)" : ""}\n`);

  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ENROLLMENT_SECTION_BACKFILL_FAILED]", err);
    process.exit(1);
  });
