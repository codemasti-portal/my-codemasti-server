const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/auth.controller");

const router = express.Router();

router.post("/otp/send", controller.sendOtp);
router.post("/otp/verify", controller.verifyOtp);
router.post("/google", controller.googleLogin);
router.post("/refresh", controller.refreshToken);
router.post("/logout", requireAuth, controller.logout);
router.get("/me", requireAuth, controller.me);

module.exports = router;
