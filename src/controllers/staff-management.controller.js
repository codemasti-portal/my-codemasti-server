const { z } = require("zod");
const bcrypt = require("bcryptjs");
const { sendSuccess, sendError } = require("../utils/response");
const Staff = require("../models/Staff");
const { ROLES, canCreateRole, canDeleteStaff, canResetPassword, permissionsForRole } = require("../utils/rbac");
const { emitEventNotification } = require("../services/staffPanelNotification.service");

function parseCsvArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function calcProfileCompletion(doc) {
  const commonChecks = [
    Boolean(doc.name),
    Boolean(doc.email),
    Boolean(doc.phone_number),
    Boolean(doc.bio),
    Number(doc.experience_years || 0) > 0,
    Boolean(doc.profile_image_url),
    Boolean(doc.resume_url),
    Boolean(doc.account_status),
  ];

  const roleChecks = [];
  if (doc.role === ROLES.INSTRUCTOR) {
    roleChecks.push((doc.subjects_teaching || []).length > 0);
    roleChecks.push((doc.batches_assigned || []).length > 0);
    roleChecks.push(Boolean(doc.experience_level));
  } else if (doc.role === ROLES.MENTOR) {
    roleChecks.push((doc.assigned_students || []).length > 0);
    roleChecks.push(Boolean(doc.expertise_area));
    roleChecks.push(Boolean(doc.availability));
  } else if (doc.role === ROLES.ADMIN) {
    roleChecks.push(Boolean(permissionsForRole(doc.role).length));
  }

  const checks = [...commonChecks, ...roleChecks];
  const completed = checks.filter(Boolean).length;
  const score = checks.length ? Math.round((completed / checks.length) * 100) : 100;
  return {
    score,
    isComplete: score >= 100,
    status: score >= 90 ? "complete" : score >= 50 ? "partial" : "incomplete",
    missingFields: buildMissingFields(doc),
  };
}

function buildMissingFields(doc) {
  const missing = [];
  if (!doc.phone_number) missing.push("phone_number");
  if (!doc.bio) missing.push("bio");
  if (!Number(doc.experience_years || 0)) missing.push("experience_years");
  if (!doc.profile_image_url) missing.push("profile_image_url");
  if (!doc.resume_url) missing.push("resume_url");
  if (!doc.account_status) missing.push("account_status");

  if (doc.role === ROLES.INSTRUCTOR) {
    if (!(doc.subjects_teaching || []).length) missing.push("subjects_teaching");
    if (!(doc.batches_assigned || []).length) missing.push("batches_assigned");
    if (!doc.experience_level) missing.push("experience_level");
  }
  if (doc.role === ROLES.MENTOR) {
    if (!(doc.assigned_students || []).length) missing.push("assigned_students");
    if (!doc.expertise_area) missing.push("expertise_area");
    if (!doc.availability) missing.push("availability");
  }
  return missing;
}

async function syncCompletion(doc) {
  const completion = calcProfileCompletion(doc);
  doc.profile_completion_score = completion.score;
  doc.is_profile_complete = completion.isComplete;
  await doc.save();
  return completion;
}

function staffPublic(doc) {
  const completion = calcProfileCompletion(doc);
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    role: doc.role,
    phone_number: doc.phone_number || "",
    profile_image_url: doc.profile_image_url || "",
    bio: doc.bio || "",
    experience_years: Number(doc.experience_years || 0),
    resume_url: doc.resume_url || "",
    account_status: doc.account_status || (doc.is_active ? "active" : "inactive"),
    subjects_teaching: doc.subjects_teaching || [],
    batches_assigned: doc.batches_assigned || [],
    experience_level: doc.experience_level || "",
    assigned_students: doc.assigned_students || [],
    expertise_area: doc.expertise_area || "",
    availability: doc.availability || "",
    profile_completion_score: completion.score,
    is_profile_complete: completion.isComplete,
    completion_status: completion.status,
    missing_fields: completion.missingFields,
    permissions_summary: permissionsForRole(doc.role),
    admin_notes: doc.admin_notes || "",
    last_updated_by_admin: doc.last_updated_by_admin || null,
    is_active: doc.is_active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Active staff with role instructor — for timetable teacher dropdown (admins + instructors). */
async function listTimetableInstructors(req, res) {
  const items = await Staff.find({ role: ROLES.INSTRUCTOR, is_active: true })
    .sort({ name: 1 })
    .select("name email")
    .lean();
  return sendSuccess(
    res,
    items.map((s) => ({
      id: String(s._id),
      name: s.name,
      email: s.email || "",
    }))
  );
}

async function listStaff(req, res) {
  const actorRole = req.staff.role;
  const filter = {};
  const role = req.query.role;
  const incompleteOnly = String(req.query.incomplete || "").toLowerCase() === "true";
  const completionLt = Number(req.query.completion_lt || 0);

  if (actorRole === ROLES.ADMIN) {
    filter.role = { $in: [ROLES.INSTRUCTOR, ROLES.MENTOR] };
  }
  if (role && [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR].includes(role)) {
    filter.role = role;
  }
  if (incompleteOnly) {
    filter.is_profile_complete = false;
  }
  if (completionLt > 0) {
    filter.profile_completion_score = { $lt: completionLt };
  }

  const items = await Staff.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  return sendSuccess(
    res,
    items.map((s) => staffPublic(s)),
    "",
    { total: items.length }
  );
}

async function createStaff(req, res) {
  const actorRole = req.staff.role;
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(2).trim(),
    role: z.enum(["admin", "instructor", "mentor"]),
    password: z.string().min(8).optional(),
  });
  const body = schema.parse(req.body);

  if (!canCreateRole(actorRole, body.role)) {
    return sendError(res, 403, "FORBIDDEN", "You cannot create this role");
  }

  const exists = await Staff.findOne({ email: body.email }).lean();
  if (exists) return sendError(res, 409, "EMAIL_EXISTS", "A staff account with this email already exists");

  const password_hash = body.password ? bcrypt.hashSync(body.password, 10) : "";
  const created = await Staff.create({
    email: body.email,
    name: body.name,
    role: body.role,
    password_hash,
    account_status: "active",
    is_active: true,
  });
  await syncCompletion(created);

  emitEventNotification({
    audience: "individual",
    recipient_id: String(created._id),
    title: "Welcome to CodeMasti",
    message: `Your ${String(created.role).replace(/_/g, " ")} account is ready. Sign in with ${created.email}.`,
    category: "updates",
    event_type: "staff_welcome",
  });
  emitEventNotification({
    audience: "role",
    target_roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN],
    title: "New team member",
    message: `${created.name} was added as ${String(created.role).replace(/_/g, " ")}.`,
    category: "updates",
    event_type: "staff_created",
    created_by: req.staff.sub,
  });

  return sendSuccess(res, staffPublic(created), "Staff created");
}

async function updateStaff(req, res) {
  const actorRole = req.staff.role;
  const schema = z.object({
    name: z.string().min(2).trim().optional(),
    email: z.string().email().optional(),
    role: z.enum(["admin", "instructor", "mentor"]).optional(),
  });
  const body = schema.parse(req.body);

  const target = await Staff.findById(req.params.id);
  if (!target) return sendError(res, 404, "NOT_FOUND", "Staff not found");

  if (target.role === ROLES.SUPER_ADMIN && body.role !== undefined) {
    return sendError(res, 403, "FORBIDDEN", "Cannot change super admin role via API");
  }

  if (actorRole === ROLES.ADMIN) {
    if (![ROLES.INSTRUCTOR, ROLES.MENTOR].includes(target.role)) {
      return sendError(res, 403, "FORBIDDEN", "You can only edit instructors and mentors");
    }
    if (body.role !== undefined && body.role !== target.role) {
      return sendError(res, 403, "FORBIDDEN", "Only super admin can change roles");
    }
  }

  if (body.role !== undefined && actorRole === ROLES.SUPER_ADMIN) {
    if (!canCreateRole(actorRole, body.role)) {
      return sendError(res, 403, "FORBIDDEN", "Invalid role target");
    }
    if (target.role === ROLES.SUPER_ADMIN) {
      return sendError(res, 403, "FORBIDDEN", "Cannot reassign super admin role");
    }
    target.role = body.role;
  }

  if (body.email !== undefined) {
    const email = body.email.toLowerCase().trim();
    const exists = await Staff.findOne({ email }).lean();
    if (exists && String(exists._id) !== String(target._id)) {
      return sendError(res, 409, "EMAIL_EXISTS", "Email already in use");
    }
    target.email = email;
  }
  if (body.name !== undefined) target.name = body.name;

  await syncCompletion(target);
  return sendSuccess(res, staffPublic(target), "Staff updated");
}

async function deleteStaff(req, res) {
  const actorRole = req.staff.role;
  const id = req.params.id;
  const target = await Staff.findById(id).lean();
  if (!target) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  if (!canDeleteStaff(actorRole, target)) {
    return sendError(res, 403, "FORBIDDEN", "You cannot remove this account");
  }

  await Staff.deleteOne({ _id: id });
  return sendSuccess(res, { id }, "Staff removed");
}

async function resetPassword(req, res) {
  const actorRole = req.staff.role;
  if (!canResetPassword(actorRole)) {
    return sendError(res, 403, "FORBIDDEN", "Only super admin can reset passwords");
  }

  const schema = z.object({
    new_password: z.string().min(8),
  });
  const body = schema.parse(req.body);
  const target = await Staff.findById(req.params.id).lean();
  if (!target) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  if (target.role === ROLES.SUPER_ADMIN) {
    return sendError(res, 403, "FORBIDDEN", "Cannot reset super admin password via API");
  }

  const password_hash = bcrypt.hashSync(body.new_password, 10);
  await Staff.updateOne({ _id: target._id }, { $set: { password_hash } });
  emitEventNotification({
    audience: "individual",
    recipient_id: String(target._id),
    title: "Password changed",
    message: "Your account password was reset by an administrator. If this wasn’t you, contact support immediately.",
    category: "alerts",
    event_type: "password_reset",
    created_by: req.staff.sub,
  });
  return sendSuccess(res, { id: String(target._id) }, "Password updated");
}

async function setActive(req, res) {
  const actorRole = req.staff.role;
  if (actorRole !== ROLES.SUPER_ADMIN) {
    return sendError(res, 403, "FORBIDDEN", "Only super admin can enable or disable accounts");
  }
  const schema = z.object({ is_active: z.boolean() });
  const body = schema.parse(req.body);
  const target = await Staff.findById(req.params.id).lean();
  if (!target) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  if (target.role === ROLES.SUPER_ADMIN) {
    return sendError(res, 403, "FORBIDDEN", "Cannot disable super admin");
  }
  await Staff.updateOne(
    { _id: target._id },
    { $set: { is_active: body.is_active, account_status: body.is_active ? "active" : "inactive" } }
  );
  return sendSuccess(res, { id: String(target._id), is_active: body.is_active }, "Updated");
}

async function getMyProfile(req, res) {
  const doc = await Staff.findById(req.staff.sub);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  await syncCompletion(doc);
  return sendSuccess(res, staffPublic(doc));
}

async function getProfileById(req, res) {
  const actorRole = req.staff.role;
  const doc = await Staff.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  if (actorRole === ROLES.ADMIN && ![ROLES.INSTRUCTOR, ROLES.MENTOR].includes(doc.role)) {
    return sendError(res, 403, "FORBIDDEN", "Admins can only view instructor/mentor profiles");
  }
  await syncCompletion(doc);
  return sendSuccess(res, staffPublic(doc));
}

async function updateMyProfile(req, res) {
  const schema = z.object({
    name: z.string().min(2).trim().optional(),
    phone_number: z.string().min(7).max(20).optional(),
    bio: z.string().max(500).optional(),
    experience_years: z.number().int().min(0).max(60).optional(),
    subjects_teaching: z.union([z.array(z.string()), z.string()]).optional(),
    batches_assigned: z.union([z.array(z.string()), z.string()]).optional(),
    experience_level: z.string().max(120).optional(),
    assigned_students: z.union([z.array(z.string()), z.string()]).optional(),
    expertise_area: z.string().max(180).optional(),
    availability: z.string().max(300).optional(),
  });
  const body = schema.parse(req.body);
  const doc = await Staff.findById(req.staff.sub);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");

  if (body.name !== undefined) doc.name = body.name;
  if (body.phone_number !== undefined) doc.phone_number = body.phone_number.trim();
  if (body.bio !== undefined) doc.bio = body.bio.trim();
  if (body.experience_years !== undefined) doc.experience_years = body.experience_years;
  if (body.subjects_teaching !== undefined) doc.subjects_teaching = parseCsvArray(body.subjects_teaching);
  if (body.batches_assigned !== undefined) doc.batches_assigned = parseCsvArray(body.batches_assigned);
  if (body.experience_level !== undefined) doc.experience_level = body.experience_level.trim();
  if (body.assigned_students !== undefined) doc.assigned_students = parseCsvArray(body.assigned_students);
  if (body.expertise_area !== undefined) doc.expertise_area = body.expertise_area.trim();
  if (body.availability !== undefined) doc.availability = body.availability.trim();

  await syncCompletion(doc);
  emitEventNotification({
    audience: "individual",
    recipient_id: String(doc._id),
    title: "Profile saved",
    message: "Your profile changes were saved successfully.",
    category: "updates",
    event_type: "profile_self_update",
  });
  return sendSuccess(res, staffPublic(doc), "Profile updated");
}

async function adminOverrideProfile(req, res) {
  const actorRole = req.staff.role;
  const schema = z.object({
    name: z.string().min(2).trim().optional(),
    email: z.string().email().optional(),
    role: z.enum(["admin", "instructor", "mentor"]).optional(),
    phone_number: z.string().min(7).max(20).optional(),
    bio: z.string().max(500).optional(),
    experience_years: z.number().int().min(0).max(60).optional(),
    resume_url: z.string().max(500).optional(),
    profile_image_url: z.string().max(500).optional(),
    account_status: z.enum(["active", "inactive", "suspended"]).optional(),
    subjects_teaching: z.union([z.array(z.string()), z.string()]).optional(),
    batches_assigned: z.union([z.array(z.string()), z.string()]).optional(),
    experience_level: z.string().max(120).optional(),
    assigned_students: z.union([z.array(z.string()), z.string()]).optional(),
    expertise_area: z.string().max(180).optional(),
    availability: z.string().max(300).optional(),
    admin_notes: z.string().max(1200).optional(),
  });
  const body = schema.parse(req.body);
  const doc = await Staff.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");

  const prevBatches = JSON.stringify(doc.batches_assigned || []);

  if (actorRole === ROLES.ADMIN) {
    if (![ROLES.INSTRUCTOR, ROLES.MENTOR].includes(doc.role)) {
      return sendError(res, 403, "FORBIDDEN", "Admins can only edit instructor/mentor profiles");
    }
    if (body.role !== undefined && body.role !== doc.role) {
      return sendError(res, 403, "FORBIDDEN", "Only super admin can change roles");
    }
  }

  if (body.role !== undefined && actorRole !== ROLES.SUPER_ADMIN) {
    return sendError(res, 403, "FORBIDDEN", "Only super admin can change roles");
  }
  if (body.role !== undefined && doc.role === ROLES.SUPER_ADMIN) {
    return sendError(res, 403, "FORBIDDEN", "Cannot change super admin role");
  }

  if (body.email !== undefined) {
    const email = body.email.toLowerCase().trim();
    const exists = await Staff.findOne({ email }).lean();
    if (exists && String(exists._id) !== String(doc._id)) {
      return sendError(res, 409, "EMAIL_EXISTS", "Email already in use");
    }
    doc.email = email;
  }

  const scalarFields = [
    "name",
    "phone_number",
    "bio",
    "experience_years",
    "resume_url",
    "profile_image_url",
    "account_status",
    "experience_level",
    "expertise_area",
    "availability",
    "admin_notes",
  ];
  for (const key of scalarFields) {
    if (body[key] !== undefined) doc[key] = typeof body[key] === "string" ? body[key].trim() : body[key];
  }
  if (body.role !== undefined) doc.role = body.role;
  if (body.subjects_teaching !== undefined) doc.subjects_teaching = parseCsvArray(body.subjects_teaching);
  if (body.batches_assigned !== undefined) doc.batches_assigned = parseCsvArray(body.batches_assigned);
  if (body.assigned_students !== undefined) doc.assigned_students = parseCsvArray(body.assigned_students);
  if (body.account_status !== undefined) doc.is_active = body.account_status === "active";

  doc.last_updated_by_admin = req.staff.sub;
  await syncCompletion(doc);

  const nextBatches = JSON.stringify(doc.batches_assigned || []);
  if (prevBatches !== nextBatches) {
    emitEventNotification({
      audience: "individual",
      recipient_id: String(doc._id),
      title: "Profile & batches updated",
      message: `An administrator updated your profile. Program / batch assignments: ${(doc.batches_assigned || []).join(", ") || "none"}.`,
      category: "assignments",
      event_type: "profile_batches_updated",
      created_by: req.staff.sub,
    });
  } else {
    emitEventNotification({
      audience: "individual",
      recipient_id: String(doc._id),
      title: "Profile updated",
      message: "Your profile was updated by an administrator.",
      category: "updates",
      event_type: "profile_updated_by_admin",
      created_by: req.staff.sub,
    });
  }

  return sendSuccess(res, staffPublic(doc), "Profile override saved");
}

async function uploadOwnProfileImage(req, res) {
  if (!req.file) return sendError(res, 400, "FILE_REQUIRED", "Profile image is required");
  const doc = await Staff.findById(req.staff.sub);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  doc.profile_image_url = `/v1/static/staff-profile-images/${req.file.filename}`;
  await syncCompletion(doc);
  return sendSuccess(res, { profile_image_url: doc.profile_image_url }, "Profile image updated");
}

async function uploadOwnResume(req, res) {
  if (!req.file) return sendError(res, 400, "FILE_REQUIRED", "Resume file is required");
  const doc = await Staff.findById(req.staff.sub);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  doc.resume_url = `/v1/static/staff-resumes/${req.file.filename}`;
  await syncCompletion(doc);
  return sendSuccess(res, { resume_url: doc.resume_url }, "Resume updated");
}

async function uploadAdminProfileImage(req, res) {
  const doc = await Staff.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  if (req.staff.role === ROLES.ADMIN && ![ROLES.INSTRUCTOR, ROLES.MENTOR].includes(doc.role)) {
    return sendError(res, 403, "FORBIDDEN", "Admins can only update instructor/mentor profiles");
  }
  if (!req.file) return sendError(res, 400, "FILE_REQUIRED", "Profile image is required");
  doc.profile_image_url = `/v1/static/staff-profile-images/${req.file.filename}`;
  doc.last_updated_by_admin = req.staff.sub;
  await syncCompletion(doc);
  return sendSuccess(res, { profile_image_url: doc.profile_image_url }, "Profile image updated");
}

async function uploadAdminResume(req, res) {
  const doc = await Staff.findById(req.params.id);
  if (!doc) return sendError(res, 404, "NOT_FOUND", "Staff not found");
  if (req.staff.role === ROLES.ADMIN && ![ROLES.INSTRUCTOR, ROLES.MENTOR].includes(doc.role)) {
    return sendError(res, 403, "FORBIDDEN", "Admins can only update instructor/mentor profiles");
  }
  if (!req.file) return sendError(res, 400, "FILE_REQUIRED", "Resume file is required");
  doc.resume_url = `/v1/static/staff-resumes/${req.file.filename}`;
  doc.last_updated_by_admin = req.staff.sub;
  await syncCompletion(doc);
  return sendSuccess(res, { resume_url: doc.resume_url }, "Resume updated");
}

async function listIncompleteProfiles(req, res) {
  const actorRole = req.staff.role;
  const role = req.query.role;
  const completionLt = Number(req.query.completion_lt || 100);
  const filter = {
    is_profile_complete: false,
    profile_completion_score: { $lt: Math.max(1, Math.min(completionLt, 100)) },
  };
  if (actorRole === ROLES.ADMIN) {
    filter.role = { $in: [ROLES.INSTRUCTOR, ROLES.MENTOR] };
  }
  if (role && [ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR].includes(role)) {
    filter.role = role;
  }
  const items = await Staff.find(filter).sort({ profile_completion_score: 1, updatedAt: 1 }).limit(250).lean();
  return sendSuccess(
    res,
    items.map((s) => staffPublic(s)),
    "",
    { total: items.length }
  );
}

async function bulkUpdateProfiles(req, res) {
  const actorRole = req.staff.role;
  const schema = z.object({
    updates: z.array(
      z.object({
        id: z.string().min(10),
        patch: z.object({
          bio: z.string().max(500).optional(),
          experience_years: z.number().int().min(0).max(60).optional(),
          subjects_teaching: z.union([z.array(z.string()), z.string()]).optional(),
          batches_assigned: z.union([z.array(z.string()), z.string()]).optional(),
          experience_level: z.string().max(120).optional(),
          assigned_students: z.union([z.array(z.string()), z.string()]).optional(),
          expertise_area: z.string().max(180).optional(),
          availability: z.string().max(300).optional(),
          account_status: z.enum(["active", "inactive", "suspended"]).optional(),
        }),
      })
    ),
  });
  const body = schema.parse(req.body);
  const results = [];
  for (const item of body.updates.slice(0, 200)) {
    const doc = await Staff.findById(item.id);
    if (!doc) continue;
    if (actorRole === ROLES.ADMIN && ![ROLES.INSTRUCTOR, ROLES.MENTOR].includes(doc.role)) {
      continue;
    }
    const patch = item.patch;
    if (patch.bio !== undefined) doc.bio = patch.bio.trim();
    if (patch.experience_years !== undefined) doc.experience_years = patch.experience_years;
    if (patch.subjects_teaching !== undefined) doc.subjects_teaching = parseCsvArray(patch.subjects_teaching);
    if (patch.batches_assigned !== undefined) doc.batches_assigned = parseCsvArray(patch.batches_assigned);
    if (patch.experience_level !== undefined) doc.experience_level = patch.experience_level.trim();
    if (patch.assigned_students !== undefined) doc.assigned_students = parseCsvArray(patch.assigned_students);
    if (patch.expertise_area !== undefined) doc.expertise_area = patch.expertise_area.trim();
    if (patch.availability !== undefined) doc.availability = patch.availability.trim();
    if (patch.account_status !== undefined) {
      doc.account_status = patch.account_status;
      doc.is_active = patch.account_status === "active";
    }
    doc.last_updated_by_admin = req.staff.sub;
    await syncCompletion(doc);
    results.push({ id: String(doc._id), profile_completion_score: doc.profile_completion_score });
  }
  return sendSuccess(res, { updated: results.length, items: results }, "Bulk update completed");
}

module.exports = {
  listTimetableInstructors,
  listStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  resetPassword,
  setActive,
  getMyProfile,
  getProfileById,
  updateMyProfile,
  adminOverrideProfile,
  uploadOwnProfileImage,
  uploadOwnResume,
  uploadAdminProfileImage,
  uploadAdminResume,
  listIncompleteProfiles,
  bulkUpdateProfiles,
};
