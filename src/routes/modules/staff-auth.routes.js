const express = require("express");
const { requireStaffAuth } = require("../../middlewares/staff.middleware");
const controller = require("../../controllers/staff-auth.controller");

const router = express.Router();

router.post("/otp/send", controller.sendOtp);
router.post("/otp/verify", controller.verifyOtp);
router.post("/refresh", controller.refreshToken);
router.post("/logout", requireStaffAuth, controller.logout);
router.get("/me", requireStaffAuth, controller.me);

module.exports = router;
