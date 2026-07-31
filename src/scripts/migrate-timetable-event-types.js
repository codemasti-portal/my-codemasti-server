/**
 * TimetableEvent type-enum migration: old enum was ["holiday", "workshop", "mentor", "event"];
 * new enum is ["holiday", "workshop", "masterclass", "hackathon", "other"].
 *
 * Remaps:
 *   - type "mentor" -> "other"  (real mentor sessions live in MentorSlot; this was never a true mentor slot)
 *   - type "event"  -> "other"  (generic bucket renamed)
 *   - "holiday"/"workshop" are unchanged
 *
 * Also backfills the new fields on every existing doc so nothing breaks under the new schema:
 *   - all_day: true (matches today's actual behavior — every event renders as a full-day block)
 *   - time: "", duration_minutes: 60, meet_link: "", section_id: "", reminder_15m_sent_at: null
 *
 * Why it's safe:
 *   - Only touches TimetableEvent; never creates/deletes docs.
 *   - Idempotent — re-running only fills fields that are still missing/old.
 *
 * Usage (from my-codemasti-server, with MONGODB_URI in .env):
 *   node src/scripts/migrate-timetable-event-types.js            # default = DRY RUN (no writes)
 *   node src/scripts/migrate-timetable-event-types.js --apply    # actually write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");

const TYPE_REMAP = { mentor: "other", event: "other" };

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  return true;
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  await connectDb();
  console.log(`\n[TIMETABLE_EVENT_MIGRATION] mode=${dryRun ? "DRY RUN (no writes)" : "APPLY (writing)"}\n`);

  // Read via the raw collection (not the Mongoose model) so old enum values don't fail schema casting.
  const coll = mongoose.connection.collection("timetableevents");
  const all = await coll.find({}).toArray();

  let typeRemapped = 0;
  let fieldsBackfilled = 0;

  for (const doc of all) {
    const oldType = doc.type;
    const newType = TYPE_REMAP[oldType] || oldType;
    const needsTypeChange = newType !== oldType;

    const set = {};
    if (needsTypeChange) set.type = newType;
    if (doc.all_day === undefined) set.all_day = true;
    if (doc.time === undefined) set.time = "";
    if (doc.duration_minutes === undefined) set.duration_minutes = 60;
    if (doc.meet_link === undefined) set.meet_link = "";
    if (doc.section_id === undefined) set.section_id = "";
    if (doc.reminder_15m_sent_at === undefined) set.reminder_15m_sent_at = null;

    if (needsTypeChange) typeRemapped += 1;
    if (Object.keys(set).length) {
      fieldsBackfilled += 1;
      if (!dryRun) {
        await coll.updateOne({ _id: doc._id }, { $set: set });
      }
    }
  }

  console.log(`  total events: ${all.length}`);
  console.log(`  type remapped (mentor/event -> other): ${typeRemapped}`);
  console.log(`  ${dryRun ? "would backfill" : "backfilled"} new fields: ${fieldsBackfilled}`);
  console.log(`\n[TIMETABLE_EVENT_MIGRATION] done${dryRun ? "  (re-run with --apply to write)" : ""}\n`);

  await mongoose.connection.close();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[TIMETABLE_EVENT_MIGRATION_FAILED]", err);
    process.exit(1);
  });
