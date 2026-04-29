const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const { studentSelfAvatarUpload } = require("../../middlewares/upload.middleware");
const controller = require("../../controllers/student.controller");

const router = express.Router();

router.post("/me/avatar", requireAuth, studentSelfAvatarUpload, controller.uploadAvatar);
router.post("/me/password", requireAuth, controller.changePassword);
router.post("/me/password/otp/send", requireAuth, controller.sendPasswordUpdateOtp);
router.post("/me/password/otp/verify", requireAuth, controller.verifyPasswordUpdateOtp);
router.post("/me/password/otp/update", requireAuth, controller.updatePasswordWithOtp);
router.get("/me", requireAuth, controller.getMe);
router.patch("/me", requireAuth, controller.patchMe);

module.exports = router;
