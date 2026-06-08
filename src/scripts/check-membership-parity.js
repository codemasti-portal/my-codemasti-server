/**
 * Read-switch GATE (read-only): compares, for every student, the legacy batch membership
 * (Student.batch_id / enrollment_number) against the enrollment-derived membership
 * (StudentEnrollment.batch_id). It NEVER writes anything.
 *
 * The decisive number is "would_be_dropped": students whose legacy set contains a batch that the
 * enrollment set does NOT (legacy ∖ enrollment ≠ ∅). At the read-switch these students would lose
 * visibility/billing under pure "enrollment" mode — so this must be ZERO before flipping
 * BATCH_MEMBERSHIP_SOURCE=enrollment (RISK 2 in BATCH_MULTIBATCH_MIGRATION_PLAN.md §10).
 * "union" mode is safe meanwhile (it never drops). Multi-batch students (enrollment ⊋ legacy) are
 * expected and fine.
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/check-membership-parity.js            # summary
 *   node src/scripts/check-membership-parity.js --list     # also list the would-be-dropped students
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Student = require("../models/Student");
const { catalogBatchIdsFromStudentLean } = require("../utils/enrollment");
const { enrollmentBatchIdsForStudent } = require("../utils/student-batch-context");

function diff(a, b) {
  const setB = new Set(b);
  return a.filter((x) => !setB.has(x));
}

async function run() {
  const showList = process.argv.slice(2).includes("--list");
  await connectDb();
  console.log(`\n[MEMBERSHIP_PARITY] read-only — comparing legacy vs enrollment-derived membership\n`);

  const students = await Student.find({ role: "student" })
    .select("_id name email batch_id enrollment_number section_id")
    .lean();

  let total = 0;
  let withLegacy = 0;
  let exactMatch = 0;
  let multiBatch = 0; // enrollment has MORE than legacy (genuine M:N) — expected/fine
  const dropped = []; // legacy ∖ enrollment ≠ ∅ — RISK 2

  for (const s of students) {
    total += 1;
    // Measure the RAW legacy set (batch_id ∪ enrollment_number-derived) — the most permissive
    // membership any legacy reader could show. Do NOT augment first: augment overwrites batch_id
    // with the enrollment-derived value, which would hide a stale batch_id that the switch WOULD
    // drop (false negative). catalogBatchIdsFromStudentLean already unions both sources.
    const legacy = catalogBatchIdsFromStudentLean(s);
    const { batchIds: enrollment } = await enrollmentBatchIdsForStudent(s._id);
    const legacySet = [...new Set(legacy.map((x) => String(x).toLowerCase()))];
    const enrSet = [...new Set(enrollment.map((x) => String(x).toLowerCase()))];

    if (legacySet.length) withLegacy += 1;

    const lostByEnrollment = diff(legacySet, enrSet); // in legacy, missing from enrollment
    const gainedByEnrollment = diff(enrSet, legacySet);

    if (!lostByEnrollment.length && !gainedByEnrollment.length) exactMatch += 1;
    if (gainedByEnrollment.length) multiBatch += 1;
    if (lostByEnrollment.length) {
      dropped.push({
        id: String(s._id),
        name: s.name,
        email: s.email,
        legacy: legacySet,
        enrollment: enrSet,
        lost: lostByEnrollment,
      });
    }
  }

  console.log(`  students scanned:            ${total}`);
  console.log(`  with a legacy batch:         ${withLegacy}`);
  console.log(`  exact match (legacy == enr): ${exactMatch}`);
  console.log(`  multi-batch (enr ⊋ legacy):  ${multiBatch}  (expected/fine)`);
  console.log(`  WOULD BE DROPPED (RISK 2):   ${dropped.length}  <-- must be 0 before BATCH_MEMBERSHIP_SOURCE=enrollment`);

  if (dropped.length && showList) {
    console.log(`\n  --- would-be-dropped students (legacy has a batch enrollment lacks) ---`);
    for (const d of dropped.slice(0, 200)) {
      console.log(`    ${d.email || d.id}: legacy=[${d.legacy.join(",")}] enrollment=[${d.enrollment.join(",")}] lost=[${d.lost.join(",")}]`);
    }
    if (dropped.length > 200) console.log(`    … and ${dropped.length - 200} more`);
  } else if (dropped.length) {
    console.log(`\n  Re-run with --list to see the affected students. Fix by ensuring each has the matching`);
    console.log(`  active enrollment (gap-fill / addStudentToBatch) before flipping to enrollment mode.`);
  }

  console.log(`\n[MEMBERSHIP_PARITY] done\n`);
  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[MEMBERSHIP_PARITY_FAILED]", err);
    process.exit(1);
  });
