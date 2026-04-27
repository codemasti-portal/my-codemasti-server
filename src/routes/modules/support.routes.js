const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/support.controller");
const { communityMediaUpload } = require("../../middlewares/upload.middleware");

const router = express.Router();

router.post("/conversations", requireAuth, controller.openOrResumeConversation);
router.get("/conversations/:conversationId/messages", requireAuth, controller.listMessages);
router.post("/conversations/:conversationId/messages", requireAuth, communityMediaUpload, controller.sendMessage);

module.exports = router;
