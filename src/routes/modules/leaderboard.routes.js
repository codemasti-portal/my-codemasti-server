const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/leaderboard.controller");

const router = express.Router();

router.get("/me", requireAuth, controller.me);
router.get("/", requireAuth, controller.list);

module.exports = router;
