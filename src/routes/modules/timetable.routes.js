const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/timetable.controller");

const router = express.Router();

router.get("/weekly", requireAuth, controller.weekly);
router.get("/recordings", requireAuth, controller.recordings);
router.get("/notes", requireAuth, controller.notes);
router.get("/events", requireAuth, controller.events);

module.exports = router;
