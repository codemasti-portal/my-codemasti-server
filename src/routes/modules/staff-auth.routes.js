const express = require("express");
const { requireStaffAuth, requireStaffRoles } = require("../../middlewares/staff.middleware");
const { ROLES } = require("../../utils/rbac");
const controller = require("../../controllers/staff-auth.controller");

const router = express.Router();

router.post("/otp/send", controller.sendOtp);
router.post("/password/otp/send", controller.sendForgotPasswordOtp);
router.post("/otp/verify", controller.verifyOtp);
router.post("/login", controller.loginWithPassword);
router.post("/signup/otp/verify", controller.verifySignupOtp);
router.post("/signup/password", controller.setPasswordFromSignup);
router.post("/password/otp/verify", controller.verifyForgotPasswordOtp);
router.post("/password/reset", controller.resetPassword);
router.post("/me/password/otp/send", requireStaffAuth, controller.sendMePasswordUpdateOtp);
router.post("/me/password/otp/verify", requireStaffAuth, controller.verifyMePasswordUpdateOtp);
router.post("/me/password/otp/update", requireStaffAuth, controller.updateMyPasswordWithOtp);
router.post(
  "/me/password/verify",
  requireStaffAuth,
  requireStaffRoles([ROLES.ADMIN, ROLES.SUPER_ADMIN]),
  controller.verifyMyPassword
);
router.post("/refresh", controller.refreshToken);
router.post("/logout", requireStaffAuth, controller.logout);
router.get("/me", requireStaffAuth, controller.me);

module.exports = router;
