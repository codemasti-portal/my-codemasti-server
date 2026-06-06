const express = require("express");
const { requireStaffAuth, requireStaffRoles } = require("../../middlewares/staff.middleware");
const { ROLES } = require("../../utils/rbac");
const controller = require("../../controllers/staff-management.controller");
const doubtsController = require("../../controllers/staff-doubts.controller");
const {
  staffProfileImageUpload,
  staffResumeUpload,
  doubtImageUpload,
  communityMediaUpload,
} = require("../../middlewares/upload.middleware");

const router = express.Router();

router.use(requireStaffAuth);

router.get(
  "/doubts/personal",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR]),
  doubtsController.listPersonal
);
router.patch(
  "/doubts/personal/:id/answer",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR]),
  doubtImageUpload,
  doubtsController.answerPersonal
);
router.get(
  "/doubts/community",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR]),
  doubtsController.listCommunity
);
router.post(
  "/doubts/community",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR]),
  communityMediaUpload,
  doubtsController.postCommunity
);
// Moderation (hide/delete) is destructive — restrict to admin/super_admin.
router.patch(
  "/doubts/community/:id/hide",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  doubtsController.hideCommunity
);
router.delete(
  "/doubts/community/:id",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  doubtsController.deleteCommunity
);

router.get(
  "/directory/instructors",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR]),
  controller.listTimetableInstructors
);

router.get("/profile/me", controller.getMyProfile);
router.put("/profile/me", controller.updateMyProfile);
router.post("/profile/upload/profile-image", staffProfileImageUpload, controller.uploadOwnProfileImage);
router.post("/profile/upload/resume", staffResumeUpload, controller.uploadOwnResume);
router.get(
  "/profiles/incomplete",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.listIncompleteProfiles
);
router.post(
  "/profiles/bulk-update",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.bulkUpdateProfiles
);
router.get(
  "/profile/:id",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.getProfileById
);
router.patch(
  "/profile/:id",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.adminOverrideProfile
);
router.post(
  "/profile/:id/upload/profile-image",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  staffProfileImageUpload,
  controller.uploadAdminProfileImage
);
router.post(
  "/profile/:id/upload/resume",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  staffResumeUpload,
  controller.uploadAdminResume
);

router.get(
  "/",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.listStaff
);
router.post(
  "/",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.createStaff
);
router.post("/:id/reset-password", requireStaffRoles([ROLES.SUPER_ADMIN]), controller.resetPassword);
router.patch("/:id/active", requireStaffRoles([ROLES.SUPER_ADMIN]), controller.setActive);
router.patch(
  "/:id",
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]),
  controller.updateStaff
);
router.delete("/:id", requireStaffRoles([ROLES.SUPER_ADMIN]), controller.deleteStaff);

module.exports = router;
