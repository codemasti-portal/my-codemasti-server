const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const { studentSelfAvatarUpload } = require("../../middlewares/upload.middleware");
const controller = require("../../controllers/student.controller");
const scorecard = require("../../controllers/student-scorecard.controller");
const monthlyLb = require("../../controllers/monthly-leaderboard-badge.controller");
const studentAchievements = require("../../controllers/student-achievement.controller");

const router = express.Router();

router.get("/me/achievements", requireAuth, studentAchievements.combinedAchievements);
router.get("/me/monthly-badges", requireAuth, monthlyLb.myMonthlyBadges);

router.post("/me/avatar", requireAuth, studentSelfAvatarUpload, controller.uploadAvatar);
router.post("/me/password", requireAuth, controller.changePassword);
router.post("/me/password/otp/send", requireAuth, controller.sendPasswordUpdateOtp);
router.post("/me/password/otp/verify", requireAuth, controller.verifyPasswordUpdateOtp);
router.post("/me/password/otp/update", requireAuth, controller.updatePasswordWithOtp);
router.get("/me", requireAuth, controller.getMe);
router.patch("/me", requireAuth, controller.patchMe);

router.get("/scorecard/tests", requireAuth, scorecard.listActiveScorecardTests);
router.get("/scorecard/records", requireAuth, scorecard.listMyScorecardRecords);

module.exports = router;
