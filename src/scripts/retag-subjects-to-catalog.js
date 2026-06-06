/**
 * One-time migration: make subjects match the batch catalog (single source of truth) for
 * BUILDERS + INNOVATORS. Spark is intentionally left untouched (confirmed clean).
 *
 *   Builders   -> [Web Development, Computational Thinking, Cyber Security]
 *   Innovators -> [Web Development, Computational Thinking, Cyber Security]
 *
 * It does two things:
 *   1. Sets each batch catalog section's subjects to the canonical three.
 *   2. Retags existing content (Arena, Assignment, TimetableSlot, LiveClass, Note) scoped to those
 *      batches, mapping every legacy free-text tag onto one of the three (see SUBJECT_MAP).
 *
 * DRY-RUN by default (reads only, prints what would change). Pass --apply to write.
 *   node src/scripts/retag-subjects-to-catalog.js            # dry run
 *   node src/scripts/retag-subjects-to-catalog.js --apply    # writes
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const BatchCatalog = require("../models/BatchCatalog");
const ArenaQuestion = require("../models/ArenaQuestion");
const Assignment = require("../models/Assignment");
const TimetableSlot = require("../models/TimetableSlot");
const LiveClass = require("../models/LiveClass");
const Note = require("../models/Note");

const APPLY = process.argv.includes("--apply");
const TARGET_BATCHES = ["builders", "innovators"];
const CANONICAL = ["Web Development", "Computational Thinking", "Cyber Security"];

// lowercased legacy tag -> canonical subject. Anything not listed is reported as UNMAPPED and left as-is.
const SUBJECT_MAP = {
  "web development": "Web Development",
  css: "Web Development",
  html: "Web Development",
  "computational thinking": "Computational Thinking",
  "computational programming": "Computational Thinking",
  "coding logic": "Computational Thinking",
  "logical thinking": "Computational Thinking",
  mathematics: "Computational Thinking",
  maths: "Computational Thinking",
  python: "Computational Thinking",
  programming: "Computational Thinking",
  "computer science": "Computational Thinking",
  "cyber security": "Cyber Security",
  networking: "Cyber Security",
};

function mapSubject(raw) {
  const k = String(raw || "").trim().toLowerCase();
  if (!k) return { skip: true };
  const canon = SUBJECT_MAP[k];
  if (!canon) return { unmapped: true };
  return { canon };
}

const batchScope = { $or: [{ batch_id: { $in: TARGET_BATCHES } }, { batch_ids: { $in: TARGET_BATCHES } }] };

async function retagModel(label, Model, filter) {
  const docs = await Model.find(filter).select("_id subject").lean();
  const changes = []; // { id, from, to }
  const unmapped = new Map(); // subject -> count
  for (const d of docs) {
    const r = mapSubject(d.subject);
    if (r.skip) continue;
    if (r.unmapped) {
      unmapped.set(d.subject, (unmapped.get(d.subject) || 0) + 1);
      continue;
    }
    if (r.canon !== d.subject) changes.push({ id: d._id, from: d.subject, to: r.canon });
  }
  // summarise from->to
  const summary = new Map();
  for (const c of changes) {
    const key = `${c.from}  ->  ${c.to}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  console.log(`\n--- ${label} (${docs.length} scoped docs) ---`);
  if (!summary.size) console.log("  no subject changes needed");
  for (const [k, n] of [...summary.entries()].sort()) console.log(`  ${n.toString().padStart(4)}  ${k}`);
  if (unmapped.size) {
    console.log("  UNMAPPED (left as-is - review!):");
    for (const [s, n] of [...unmapped.entries()].sort()) console.log(`    ${n.toString().padStart(4)}  "${s}"`);
  }
  if (APPLY && changes.length) {
    let done = 0;
    for (const c of changes) {
      await Model.updateOne({ _id: c.id }, { $set: { subject: c.to } });
      done++;
    }
    console.log(`  APPLIED ${done} updates`);
  }
  return { scanned: docs.length, changed: changes.length, unmapped: [...unmapped.keys()] };
}

async function updateCatalog() {
  console.log("\n========== CATALOG ==========");
  for (const bid of TARGET_BATCHES) {
    const cat = await BatchCatalog.findOne({ batch_id: bid });
    if (!cat) {
      console.log(`  ${bid}: NOT FOUND`);
      continue;
    }
    const sections = Array.isArray(cat.sections) ? cat.sections : [];
    const before = sections.map((s) => (s.subjects || []).join(", "));
    console.log(`  ${bid}: sections=${sections.length}  current subjects=[${[...new Set(sections.flatMap((s) => s.subjects || []))].join(", ")}]`);
    console.log(`         -> setting every section's subjects to [${CANONICAL.join(", ")}]`);
    if (APPLY) {
      for (const s of sections) s.subjects = [...CANONICAL];
      if (!sections.length) {
        cat.sections = [{ section_id: "core", name: "Core", subjects: [...CANONICAL] }];
        console.log("         (no section existed - created 'core')");
      }
      cat.markModified("sections");
      await cat.save();
      console.log("  APPLIED");
    }
    void before;
  }
}

(async () => {
  await connectDb();
  console.log(APPLY ? "=== APPLY MODE (writing) ===" : "=== DRY RUN (no writes) — pass --apply to write ===");
  console.log("Target batches:", TARGET_BATCHES.join(", "), "| Spark: untouched");

  await updateCatalog();

  console.log("\n========== CONTENT RETAG ==========");
  const results = {};
  results.arena = await retagModel("ArenaQuestion", ArenaQuestion, batchScope);
  results.assignment = await retagModel("Assignment", Assignment, batchScope);
  results.timetable = await retagModel("TimetableSlot", TimetableSlot, batchScope);
  results.liveclass = await retagModel("LiveClass", LiveClass, batchScope);
  results.note = await retagModel("Note", Note, { target_batch_ids: { $in: TARGET_BATCHES } });

  const totalChanged = Object.values(results).reduce((a, r) => a + r.changed, 0);
  const anyUnmapped = Object.values(results).some((r) => r.unmapped.length);
  console.log(`\n========== SUMMARY ==========`);
  console.log(`Total content docs that would change: ${totalChanged}`);
  if (anyUnmapped) console.log("⚠️  Some subjects are UNMAPPED above — add them to SUBJECT_MAP or fix manually before/after apply.");
  if (!APPLY) console.log("\nDry run only. Re-run with --apply to write these changes.");

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("MIGRATION FAILED:", e);
  process.exit(1);
});
