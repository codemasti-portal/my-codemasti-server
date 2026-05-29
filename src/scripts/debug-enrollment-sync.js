/**
 * Read-only diagnostic: dumps Course → linked_batch_id mapping, then for each Student
 * shows their current batch_id vs active enrollment course. Helps explain why a
 * particular student isn't getting expected invoices.
 *
 *   node src/scripts/debug-enrollment-sync.js
 *   node src/scripts/debug-enrollment-sync.js S260189   # filter to one student
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Student = require("../models/Student");
const Course = require("../models/Course");
const StudentEnrollment = require("../models/StudentEnrollment");

async function run() {
  const filterEnr = (process.argv[2] || "").trim().toUpperCase();
  await connectDb();

  // 1. Courses
  const courses = await Course.find().select("_id code name linked_batch_id is_active").lean();
  console.log("=== Courses ===");
  for (const c of courses) {
    console.log(`  ${c.is_active ? "[A]" : "[X]"} ${c.code.padEnd(20)} name=${(c.name || "").padEnd(25)} linked_batch_id="${c.linked_batch_id || ""}" id=${c._id}`);
  }
  console.log("");

  const courseByBatch = new Map(
    courses
      .filter((c) => c.is_active && c.linked_batch_id)
      .map((c) => [String(c.linked_batch_id).toLowerCase(), c])
  );

  // 2. Students
  const filter = { role: "student" };
  if (filterEnr) filter.enrollment_number = filterEnr;
  const students = await Student.find(filter)
    .select("_id name email enrollment_number batch_id batch")
    .limit(filterEnr ? 5 : 200)
    .lean();

  console.log(`=== Students (${students.length}${filterEnr ? "" : ", first 200"}) ===`);
  let mismatches = 0;
  for (const s of students) {
    const enrolls = await StudentEnrollment.find({ student_id: s._id })
      .populate({ path: "course_id", select: "code name linked_batch_id" })
      .lean();
    const active = enrolls.filter((e) => e.status === "active");
    const expectedCourse = courseByBatch.get(String(s.batch_id || "").toLowerCase());
    const matchedActive = active.find(
      (e) => expectedCourse && String(e.course_id?._id) === String(expectedCourse._id)
    );

    const line = `${(s.enrollment_number || "—").padEnd(8)} ${s.batch_id?.padEnd(12) || "—".padEnd(12)} | expected_course=${(expectedCourse?.code || "—").padEnd(12)} | active=${active.length} ${
      active.map((e) => `[${e.course_id?.code || "?"}]`).join(" ")
    }`;
    if (!expectedCourse) {
      console.log(`  ⚠ ${line}    (no Course with linked_batch_id="${s.batch_id}")`);
    } else if (!matchedActive) {
      console.log(`  ✗ ${line}    MISMATCH — active enrollment doesn't match batch_id`);
      mismatches += 1;
    } else if (filterEnr) {
      console.log(`  ✓ ${line}    OK`);
    }
  }

  console.log("");
  console.log(`Mismatches: ${mismatches}`);
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch (e) { /* ignore */ }
  process.exit(1);
});
