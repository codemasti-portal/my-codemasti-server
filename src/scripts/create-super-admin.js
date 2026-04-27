/**
 * Upserts a super_admin staff row (bcrypt password_hash; admin login is still OTP).
 *
 * Requires env (or entries in .env):
 *   SUPER_ADMIN_EMAIL
 *   SUPER_ADMIN_PASSWORD
 * Optional: SUPER_ADMIN_NAME (default "Super Admin")
 *
 * Usage: npm run create-super-admin
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectDb } = require("../config/db");
const Staff = require("../models/Staff");

const EMAIL = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
const PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "";
const NAME = (process.env.SUPER_ADMIN_NAME || "Super Admin").trim();

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error(
      "Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in the environment or .env, then run again."
    );
    process.exit(1);
  }
  await connectDb();
  const password_hash = bcrypt.hashSync(PASSWORD, 10);
  await Staff.updateOne(
    { email: EMAIL },
    {
      $set: {
        email: EMAIL,
        name: NAME || "Super Admin",
        role: "super_admin",
        password_hash,
        is_active: true,
      },
    },
    { upsert: true }
  );
  console.log("Super admin upserted:", EMAIL);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.connection.close();
  process.exit(1);
});
