const Staff = require("../models/Staff");

/** Student-facing label (role only, no personal name). */
function postedByStudentLabel(role) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "instructor") return "Instructor";
  if (r === "admin" || r === "super_admin") return "Admin";
  return "Institute";
}

/** Staff panel table: role badge text. */
function postedByStaffRoleLabel(role) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "super_admin") return "Super Admin";
  if (r === "admin") return "Admin";
  if (r === "instructor") return "Instructor";
  if (r === "mentor") return "Mentor";
  return "";
}

async function announcementCreatorFields(req) {
  const role = String(req.staff?.role || "").trim().toLowerCase();
  const sub = req.staff?.sub;
  let name = String(req.staff?.name || "").trim();
  if (!name && sub) {
    const doc = await Staff.findById(sub).select("name").lean();
    name = String(doc?.name || "").trim();
  }
  return {
    created_by_staff_id: sub || null,
    created_by_name: name || "Staff",
    created_by_role: role,
  };
}

module.exports = {
  postedByStudentLabel,
  postedByStaffRoleLabel,
  announcementCreatorFields,
};
