const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/assignment.controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);
router.get("/filters", requireAuth, controller.filters);
router.get("/:assignmentId/questions/:questionId", requireAuth, controller.questionDetail);
router.post("/:assignmentId/questions/:questionId/run", requireAuth, controller.run);
router.post("/:assignmentId/questions/:questionId/submit", requireAuth, controller.submit);
router.get("/:assignmentId/questions/:questionId/submissions", requireAuth, controller.submissions);

module.exports = router;
