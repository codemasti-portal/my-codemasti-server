const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/mentor-sessions.controller");

const router = express.Router();

router.get("/slots", requireAuth, controller.listSlots);
router.get("/me", requireAuth, controller.mySessions);
router.post("/slots/:slotId/book", requireAuth, controller.book);
router.post("/slots/:slotId/cancel", requireAuth, controller.cancelBooking);
router.post("/:sessionId/join", requireAuth, controller.joinSession);

module.exports = router;
