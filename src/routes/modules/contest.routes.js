const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/contest.controller");

const router = express.Router();

router.get("/", requireAuth, controller.listMyContests);
router.get("/:id", requireAuth, controller.getMyContest);

module.exports = router;
