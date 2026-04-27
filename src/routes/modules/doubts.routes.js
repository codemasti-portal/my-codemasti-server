const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const { doubtImageUpload, communityMediaUpload } = require("../../middlewares/upload.middleware");
const controller = require("../../controllers/doubts.controller");

const router = express.Router();

router.post("/personal", requireAuth, doubtImageUpload, controller.createPersonal);
router.get("/subjects", requireAuth, controller.listSubjects);
router.get("/personal", requireAuth, controller.listPersonal);
router.get("/community/channels/:channelId/messages", requireAuth, controller.listCommunityMessages);
router.post("/community/channels/:channelId/messages", requireAuth, communityMediaUpload, controller.postCommunityMessage);
router.post("/community/messages/:messageId/like", requireAuth, controller.likeCommunityMessage);

module.exports = router;
