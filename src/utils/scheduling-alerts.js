const { ROLES } = require("./rbac");

const SCHEDULING_ALERT_ELIGIBLE_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

function isSchedulingAlertEligibleRole(role) {
  return SCHEDULING_ALERT_ELIGIBLE_ROLES.includes(String(role || "").trim());
}

/**
 * Staff may only keep receives_scheduling_alerts=true when role is admin or super_admin.
 */
function normalizeSchedulingAlertsFlag(role, flag) {
  if (!isSchedulingAlertEligibleRole(role)) return false;
  return flag === true;
}

module.exports = {
  SCHEDULING_ALERT_ELIGIBLE_ROLES,
  isSchedulingAlertEligibleRole,
  normalizeSchedulingAlertsFlag,
};
