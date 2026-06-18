const express = require("express");
const { requireStaffAuth, requireStaffRoles } = require("../../middlewares/staff.middleware");
const { ROLES } = require("../../utils/rbac");
const controller = require("../../controllers/staff-panel-notifications.controller");

const router = express.Router();
const manage = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];

router.get("/me", requireStaffAuth, controller.listMine);
router.get("/me/unread-count", requireStaffAuth, controller.unreadCount);
router.post("/me/:id/read", requireStaffAuth, controller.postReadOne);
router.post("/me/mark-all-read", requireStaffAuth, controller.postMarkAllRead);
router.post("/me/clear-all", requireStaffAuth, controller.postClearAll);

router.post("/", ...manage, controller.adminCreate);
router.get("/admin", ...manage, controller.adminList);
router.patch("/admin/:id", ...manage, controller.adminPatch);
router.delete("/admin/:id", ...manage, controller.adminDelete);

module.exports = router;
