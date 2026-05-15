const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/leaderboard.controller");
const monthlyBadges = require("../../controllers/monthly-leaderboard-badge.controller");

const router = express.Router();

router.get("/monthly-winners", requireAuth, monthlyBadges.leaderboardMonthlyWinners);
router.get("/me", requireAuth, controller.me);
router.get("/", requireAuth, controller.list);

module.exports = router;
