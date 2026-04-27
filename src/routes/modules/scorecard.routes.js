const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/scorecard.controller");

const router = express.Router();

router.get("/months", requireAuth, controller.months);
router.get("/:month_key/report.pdf", requireAuth, controller.reportPdf);
router.get("/:month_key", requireAuth, controller.detail);

module.exports = router;
