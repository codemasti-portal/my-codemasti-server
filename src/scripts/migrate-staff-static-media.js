require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Staff = require("../models/Staff");

function isDryRun(argv) {
  if (argv.includes("--apply")) return false;
  if (argv.includes("--dry-run")) return true;
  const env = String(process.env.DRY_RUN || "").trim();
  if (!env) return true;
  return !/^(false|0|no)$/i.test(env);
}

function buildStaticUrlRegex() {
  // Matches either:
  // - relative "/v1/static/..."
  // - absolute "https://host/v1/static/..."
  return /(\/v1\/static\/)/i;
}

async function run() {
  const dryRun = isDryRun(process.argv.slice(2));
  const rx = buildStaticUrlRegex();

  await connectDb();

  const filter = {
    $or: [{ profile_image_url: rx }, { resume_url: rx }],
  };

  const matched = await Staff.countDocuments(filter);

  if (dryRun) {
    console.log(`[DRY RUN] Matched staff docs: ${matched}`);
    console.log('Re-run with "--apply" to clear local static URLs.');
    await mongoose.connection.close();
    return;
  }

  const result = await Staff.updateMany(
    filter,
    {
      $set: { profile_image_url: "", resume_url: "" },
    },
    { strict: true }
  );

  const modified = Number(result.modifiedCount ?? result.nModified ?? 0);
  console.log(`Matched staff docs: ${matched}`);
  console.log(`Updated staff docs: ${modified}`);
  console.log("Done.");

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

