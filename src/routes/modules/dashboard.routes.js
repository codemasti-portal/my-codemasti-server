const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/dashboard.controller");

const router = express.Router();

router.get("/summary", requireAuth, controller.summary);
router.get("/home", requireAuth, controller.home);

module.exports = router;
