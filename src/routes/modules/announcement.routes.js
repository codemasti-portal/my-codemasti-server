const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/announcement.controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);

module.exports = router;
