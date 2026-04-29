const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/auth.controller");

const router = express.Router();

router.post("/otp/send", controller.sendOtp);
router.post("/password/otp/send", controller.sendForgotPasswordOtp);
router.post("/otp/verify", controller.verifyOtp);
router.post("/login", controller.loginWithPassword);
router.post("/signup/otp/verify", controller.verifySignupOtp);
router.post("/signup/password", controller.setPasswordFromSignup);
router.post("/password/otp/verify", controller.verifyPasswordResetOtp);
router.post("/password/reset", controller.resetPasswordWithToken);
router.post("/google", controller.googleLogin);
router.post("/refresh", controller.refreshToken);
router.post("/logout", requireAuth, controller.logout);
router.get("/me", requireAuth, controller.me);

module.exports = router;
