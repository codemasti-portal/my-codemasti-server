/** Role hierarchy and permission helpers for admin panel staff. */

const ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  INSTRUCTOR: "instructor",
  MENTOR: "mentor",
};

/** Permissions returned to the client for UI gating; server routes enforce separately. */
const ROLE_PERMISSIONS = {
  super_admin: [
    "staff:manage",
    "staff:reset_password",
    "students:manage",
    "content:manage",
    "live_classes:manage",
    "doubt_sessions:manage",
    "mentor_sessions:manage",
    "dashboard:view",
    "analytics:view",
    "settings:manage",
  ],
  admin: [
    "students:manage",
    "content:manage",
    "live_classes:manage",
    "doubt_sessions:manage",
    "mentor_sessions:manage",
    "dashboard:view",
    "analytics:view",
  ],
  instructor: [
    "notes:upload",
    "live_classes:create",
    "doubt_sessions:schedule",
    "assignments:upload",
    "course:manage",
    "students:view_course",
    "dashboard:view",
  ],
  mentor: [
    "mentor_sessions:schedule",
    "students:view_assigned",
    "mentor_notes:add",
    "progress:track",
    "session_reports:view",
    "dashboard:view",
  ],
};

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function canManageStaff(actorRole) {
  return actorRole === ROLES.SUPER_ADMIN;
}

function canCreateRole(actorRole, targetRole) {
  if (actorRole === ROLES.SUPER_ADMIN) {
    return ["admin", "instructor", "mentor"].includes(targetRole);
  }
  if (actorRole === ROLES.ADMIN) {
    return ["instructor", "mentor"].includes(targetRole);
  }
  return false;
}

function canDeleteStaff(actorRole, target) {
  if (actorRole !== ROLES.SUPER_ADMIN) return false;
  if (target.role === ROLES.SUPER_ADMIN) return false;
  return true;
}

function canResetPassword(actorRole) {
  return actorRole === ROLES.SUPER_ADMIN;
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  permissionsForRole,
  canManageStaff,
  canCreateRole,
  canDeleteStaff,
  canResetPassword,
};
