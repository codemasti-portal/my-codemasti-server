const express = require("express");
const { requireAuth } = require("../../middlewares/auth.middleware");
const controller = require("../../controllers/notes.controller");

const router = express.Router();

router.get("/", requireAuth, controller.list);
router.get("/filters", requireAuth, controller.filters);
router.get("/:noteId", requireAuth, controller.detail);
router.get("/:noteId/download", requireAuth, controller.download);

module.exports = router;
