const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/notifications.controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);
router.get("/unread-count", requireAuth, controller.unreadCount);
router.post("/mark-all-read", requireAuth, controller.markAllRead);
router.post("/:id/read", requireAuth, controller.markRead);

module.exports = router;
