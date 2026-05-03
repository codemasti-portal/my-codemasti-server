const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/classes.controller");

const router = express.Router();

router.get("/live", requireAuth, controller.live);
router.get("/recordings", requireAuth, controller.recordings);
router.post("/:classId/join", requireAuth, controller.join);
router.get("/:classId/joins", requireAuth, controller.joins);

module.exports = router;
