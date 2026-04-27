const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/arena.controller");

const router = express.Router();

router.get("/activity", requireAuth, controller.activity);
router.get("/questions", requireAuth, controller.list);
router.get("/questions/:questionId", requireAuth, controller.detail);
router.post("/questions/:questionId/run", requireAuth, controller.run);
router.post("/questions/:questionId/submit", requireAuth, controller.submit);
router.get("/questions/:questionId/submissions", requireAuth, controller.submissions);

module.exports = router;
