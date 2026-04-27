const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/referral.controller");

const router = express.Router();

router.get("/me", requireAuth, controller.me);
router.get("/events", requireAuth, controller.events);

module.exports = router;
