/**
 * Seed the 3 legacy "main" courses (Spark / Builders / Innovators) and create one
 * active StudentEnrollment per existing student based on their current `batch_id`.
 *
 * Idempotent — safe to re-run.
 *
 * Usage (from repo root, with MONGODB_URI in .env):
 *   node src/scripts/backfill-enrollments.js              # default = dry run
 *   node src/scripts/backfill-enrollments.js --dry-run    # explicit
 *   node src/scripts/backfill-enrollments.js --apply      # actually write
 *
 * IMPORTANT: courses are seeded with `base_fee_paise: 0`. Update real fees in the
 * admin Courses UI (or via direct DB) before generating any invoices.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Student = require("../models/Student");
const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");

const LEGACY_COURSES = [
  { code: "spark", name: "Spark", linked_batch_id: "spark", category: "specialization", duration_months: 12, billing_mode: "monthly" },
  { code: "builders", name: "Builders", linked_batch_id: "builders", category: "specialization", duration_months: 12, billing_mode: "monthly" },
  { code: "innovators", name: "Innovators", linked_batch_id: "innovators", category: "specialization", duration_months: 12, billing_mode: "monthly" },
];

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true; // default + --dry-run
}

async function seedCourses({ dryRun }) {
  const created = [];
  const existing = [];
  for (const c of LEGACY_COURSES) {
    const found = await Course.findOne({ code: c.code }).lean();
    if (found) {
      existing.push(found);
      continue;
    }
    if (dryRun) {
      created.push({ ...c, _id: "(would-create)", base_fee_paise: 0, is_active: true });
    } else {
      const doc = await Course.create({ ...c, base_fee_paise: 0, is_active: true });
      created.push(doc.toObject());
    }
  }
  return { created, existing };
}

async function planEnrollments(coursesByBatchId) {
  // Find students with a batch_id that maps to one of our legacy courses, and no existing active enrollment for it.
  const wantedBatchIds = Object.keys(coursesByBatchId);
  const students = await Student.find({ batch_id: { $in: wantedBatchIds } })
    .select("_id name email batch_id")
    .lean();

  const work = [];
  for (const s of students) {
    const course = coursesByBatchId[String(s.batch_id || "").toLowerCase()];
    if (!course || !course._id || course._id === "(would-create)") {
      // course doesn't yet exist in DB — skip in dry-run if it would have to be created first
      work.push({ student: s, course, action: "skip-course-missing" });
      continue;
    }
    const existing = await StudentEnrollment.findOne({
      student_id: s._id,
      course_id: course._id,
      status: { $in: ["active", "completed"] },
    }).lean();
    if (existing) {
      work.push({ student: s, course, action: "already-enrolled" });
    } else {
      work.push({ student: s, course, action: "create" });
    }
  }
  return work;
}

async function run() {
  const argv = process.argv.slice(2);
  const dryRun = isDryRun(argv);

  await connectDb();

  console.log(dryRun ? "[DRY RUN] No writes. Use --apply to commit changes." : "[APPLY] Writing changes.");
  console.log("---");

  // Step 1 — seed courses
  const { created: coursesCreated, existing: coursesExisting } = await seedCourses({ dryRun });
  console.log(`Courses already present: ${coursesExisting.length}`);
  for (const c of coursesExisting) console.log(`  - ${c.code} (id=${c._id})`);
  console.log(`Courses ${dryRun ? "would create" : "created"}: ${coursesCreated.length}`);
  for (const c of coursesCreated) console.log(`  + ${c.code} (id=${c._id})`);

  // Step 2 — map batch_id → Course for enrollment planning
  const coursesByBatchId = {};
  for (const c of [...coursesExisting, ...coursesCreated]) {
    if (c.linked_batch_id) coursesByBatchId[c.linked_batch_id] = c;
  }

  if (!Object.keys(coursesByBatchId).length) {
    console.log("No legacy courses available. Aborting enrollment backfill.");
    await mongoose.connection.close();
    return;
  }

  // Step 3 — plan enrollments
  const plan = await planEnrollments(coursesByBatchId);
  const toCreate = plan.filter((p) => p.action === "create");
  const alreadyEnrolled = plan.filter((p) => p.action === "already-enrolled");
  const skipped = plan.filter((p) => p.action === "skip-course-missing");

  console.log("---");
  console.log(`Students matched: ${plan.length}`);
  console.log(`  already enrolled: ${alreadyEnrolled.length}`);
  console.log(`  would create:     ${toCreate.length}`);
  console.log(`  skipped (course pending create): ${skipped.length}`);

  if (toCreate.length) {
    console.log("Sample to create (first 5):");
    for (const p of toCreate.slice(0, 5)) {
      console.log(`  ${p.student.email}  batch_id=${p.student.batch_id}  →  ${p.course.code}`);
    }
  }

  if (dryRun) {
    console.log("---");
    console.log("[DRY RUN] No DB writes performed. Re-run with --apply to commit.");
    console.log("NOTE: Seeded courses have base_fee_paise=0. Update fees in admin Courses UI before generating invoices.");
    await mongoose.connection.close();
    return;
  }

  // Step 4 — apply enrollments
  let created = 0;
  let failed = 0;
  for (const p of toCreate) {
    try {
      await StudentEnrollment.create({
        student_id: p.student._id,
        course_id: p.course._id,
        status: "active",
        started_on: new Date(),
        notes: "Backfilled from Student.batch_id",
      });
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`  ! Failed for ${p.student.email}: ${err.message}`);
    }
  }
  console.log("---");
  console.log(`Enrollments created: ${created}, failed: ${failed}`);
  console.log("Done. Remember to set course base_fee_paise in admin UI before generating invoices.");

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error("Backfill failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
