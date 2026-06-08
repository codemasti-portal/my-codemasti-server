const express = require("express");
const { requireStaffAuth, requireStaffRoles } = require("../../middlewares/staff.middleware");
const { ROLES } = require("../../utils/rbac");
const controller = require("../../controllers/admin.controller");
const content = require("../../controllers/admin-content.controller");
const catalog = require("../../controllers/admin-catalog.controller");
const batchCatalog = require("../../controllers/admin-batch-catalog.controller");
const adminUpload = require("../../controllers/admin-upload.controller");
const adminScorecard = require("../../controllers/admin-scorecard.controller");
const adminContest = require("../../controllers/admin-contest.controller");
const adminSupport = require("../../controllers/admin-support.controller");
const adminTodo = require("../../controllers/admin-todo.controller");
const adminMonthlyLeaderboard = require("../../controllers/admin-monthly-leaderboard.controller");
const adminStudentAchievements = require("../../controllers/admin-student-achievement.controller");
const adminBadgeDefinitions = require("../../controllers/admin-badge-definition.controller");
const adminBadgeProgram = require("../../controllers/admin-badge-program.controller");
const uploadMw = require("../../middlewares/upload.middleware");

const router = express.Router();

/** Admins (+ super_admin) only — destructive / catalog-owner actions */
const manageContent = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];
/** Announcements: admins full access; instructors batch-scoped writes (enforced in controller). */
const manageAnnouncements = [
  requireStaffAuth,
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR]),
];
/** Admins only — ops modules not exposed to instructors (support, mentor slots, badge studio reads, batch hub detail) */
const adminPanelRead = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];
/** Instructors share read access for teaching modules only (announcements, arena reads, etc.) */
const staffPanelRead = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageNotes = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageLiveClasses = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageAssignments = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const readTimetable = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageTimetable = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];
const readScorecard = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
/** Batch list only — instructors need this for timetable / assignment batch dropdowns (no batch hub UI) */
const batchListRead = [
  requireStaffAuth,
  requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR, ROLES.MENTOR]),
];
/** Batch hub: single batch + roster — admin panel only */
const batchHubRead = adminPanelRead;
const viewStudents = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const adminOnly = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];

router.get("/announcements", ...staffPanelRead, content.listAnnouncements);
router.post("/announcements", ...manageAnnouncements, content.createAnnouncement);
router.get("/announcements/:id", ...staffPanelRead, content.getAnnouncement);
router.patch("/announcements/:id", ...manageAnnouncements, content.updateAnnouncement);
router.delete("/announcements/:id", ...manageAnnouncements, content.deleteAnnouncement);

router.get("/notes", ...manageNotes, content.listNotes);
router.post("/notes", ...manageNotes, content.createNote);
router.get("/notes/:id", ...manageNotes, content.getNote);
router.patch("/notes/:id", ...manageNotes, content.updateNote);
router.delete("/notes/:id", ...manageNotes, content.deleteNote);

router.post(
  "/uploads/note-asset",
  ...manageNotes,
  uploadMw.noteAssetUpload,
  adminUpload.uploadNoteAsset
);

router.post(
  "/uploads/assignment-asset",
  ...manageAssignments,
  uploadMw.assignmentAssetUpload,
  adminUpload.uploadAssignmentAsset
);
router.post(
  "/uploads/assignment-question-asset",
  ...manageAssignments,
  uploadMw.assignmentAssetUpload,
  adminUpload.uploadAssignmentQuestionAsset
);
router.post(
  "/uploads/badge-program-art",
  ...manageContent,
  uploadMw.badgeProgramArtUpload,
  adminUpload.uploadBadgeProgramArt
);

router.get(
  "/assignments/:assignmentId/questions/:questionId",
  ...manageAssignments,
  catalog.getAssignmentQuestion
);
router.patch(
  "/assignments/:assignmentId/questions/:questionId",
  ...manageAssignments,
  catalog.updateAssignmentQuestion
);
router.delete(
  "/assignments/:assignmentId/questions/:questionId",
  ...manageAssignments,
  catalog.deleteAssignmentQuestion
);
router.get("/assignments/:assignmentId/questions", ...manageAssignments, catalog.listAssignmentQuestions);
router.post("/assignments/:assignmentId/questions", ...manageAssignments, catalog.createAssignmentQuestion);

router.get("/assignments", ...manageAssignments, catalog.listAssignments);
router.post("/assignments", ...manageAssignments, catalog.createAssignment);
router.get("/assignments/:id", ...manageAssignments, catalog.getAssignment);
router.patch("/assignments/:id", ...manageAssignments, catalog.updateAssignment);
router.delete("/assignments/:id", ...manageAssignments, catalog.deleteAssignment);

router.get("/arena/questions", ...staffPanelRead, catalog.listArenaQuestions);
router.post("/arena/questions", ...manageContent, catalog.createArenaQuestion);
router.get("/arena/questions/:id", ...staffPanelRead, catalog.getArenaQuestion);
router.patch("/arena/questions/:id", ...manageContent, catalog.updateArenaQuestion);
router.delete("/arena/questions/:id", ...manageContent, catalog.deleteArenaQuestion);

router.get("/live-classes", ...manageLiveClasses, catalog.listLiveClasses);
router.post("/live-classes", ...manageLiveClasses, catalog.createLiveClass);
router.get("/live-classes/:id", ...manageLiveClasses, catalog.getLiveClass);
router.patch("/live-classes/:id", ...manageLiveClasses, catalog.updateLiveClass);
router.delete("/live-classes/:id", ...manageLiveClasses, catalog.deleteLiveClass);

router.get("/timetable/slots", ...readTimetable, catalog.listTimetableSlots);
router.get("/timetable/schedule", ...readTimetable, catalog.listTimetableSchedule);
router.get("/timetable/google-meet/status", ...manageTimetable, catalog.googleMeetCalendarStatus);
router.post("/timetable/google-meet", ...manageTimetable, catalog.provisionTimetableGoogleMeet);
router.post("/timetable/slots", ...manageTimetable, catalog.createTimetableSlot);
router.get("/timetable/slots/:id", ...readTimetable, catalog.getTimetableSlot);
router.patch("/timetable/slots/:id", ...manageTimetable, catalog.updateTimetableSlot);
router.delete("/timetable/slots/:id", ...manageTimetable, catalog.deleteTimetableSlot);

router.get("/timetable/events", ...readTimetable, catalog.listTimetableEvents);
router.post("/timetable/events", ...manageTimetable, catalog.createTimetableEvent);
router.get("/timetable/events/:id", ...readTimetable, catalog.getTimetableEvent);
router.patch("/timetable/events/:id", ...manageTimetable, catalog.updateTimetableEvent);
router.delete("/timetable/events/:id", ...manageTimetable, catalog.deleteTimetableEvent);

router.get("/mentor-slots", ...adminPanelRead, catalog.listMentorSlotsAdmin);
router.post("/mentor-slots", ...manageContent, catalog.createMentorSlot);
router.get("/mentor-slots/:id", ...adminPanelRead, catalog.getMentorSlot);
router.patch("/mentor-slots/:id", ...manageContent, catalog.updateMentorSlot);
router.delete("/mentor-slots/:id", ...manageContent, catalog.deleteMentorSlot);

router.get("/batches", ...batchListRead, batchCatalog.list);
router.post("/batches", ...manageContent, batchCatalog.create);
router.get("/batches/:batch_id/students", ...batchHubRead, batchCatalog.listStudentsInBatch);
router.get("/batches/:batch_id", ...batchHubRead, batchCatalog.getOne);
router.patch("/batches/:batch_id", ...manageContent, batchCatalog.update);
router.delete("/batches/:batch_id", ...manageContent, batchCatalog.remove);

router.get("/students", ...viewStudents, controller.listStudents);
// Specific /students/* routes MUST precede the /students/:id param route below.
router.get("/students/lookup", ...adminOnly, controller.lookupStudentByEmail);
router.get("/students/next-enrollment", ...adminOnly, controller.nextEnrollmentNumber);
router.post("/students", ...adminOnly, controller.createStudent);
router.get("/students/:id", ...viewStudents, controller.getStudent);
router.patch("/students/:id", ...adminOnly, controller.updateStudent);
// Multi-batch membership (additive): add to / remove from a batch without affecting other batches.
router.post("/students/:id/batches", ...adminOnly, controller.addStudentBatch);
router.delete("/students/:id/batches/:batch_id", ...adminOnly, controller.removeStudentBatch);
router.post(
  "/students/:id/avatar",
  ...adminOnly,
  uploadMw.adminStudentAvatarUpload,
  controller.uploadStudentAvatar
);
router.delete("/students/:id", ...adminOnly, controller.deleteStudent);

router.get("/scorecard/entries", ...readScorecard, adminScorecard.listEntries);
router.post("/scorecard/entries", ...adminOnly, adminScorecard.createEntry);
router.post("/scorecard/entries/bulk", ...adminOnly, adminScorecard.bulkCreateEntries);
router.get("/scorecard/spreadsheet-students", ...readScorecard, adminScorecard.spreadsheetStudents);
router.post("/scorecard/entries/batch-save", ...adminOnly, adminScorecard.batchSaveEntries);
router.post("/scorecard/entries/bulk-by-cst", ...adminOnly, adminScorecard.bulkCreateByCst);
router.patch("/scorecard/entries/:id", ...adminOnly, adminScorecard.patchEntry);
router.delete("/scorecard/entries/:id", ...adminOnly, adminScorecard.deleteEntry);
router.get("/scorecard/records", ...readScorecard, adminScorecard.listRecords);
router.get("/scorecard/summary", ...readScorecard, adminScorecard.scorecardSummary);
router.get("/scorecard/tests", ...readScorecard, adminScorecard.listTests);
router.post("/scorecard/tests", ...adminOnly, adminScorecard.createTest);
router.patch("/scorecard/tests/:id", ...adminOnly, adminScorecard.patchTest);
router.delete("/scorecard/tests/:id", ...adminOnly, adminScorecard.deleteTest);
router.post("/scorecard/tests/:id/mark-absent-zero", ...adminOnly, adminScorecard.markAbsentAsZero);

router.get("/contests", ...readScorecard, adminContest.listContests);
router.post("/contests", ...adminOnly, adminContest.createContest);
router.post("/contests/bulk", ...adminOnly, adminContest.bulkCreateContests);
router.get("/contests/:id", ...readScorecard, adminContest.getContest);
router.patch("/contests/:id", ...adminOnly, adminContest.patchContest);
router.delete("/contests/:id", ...adminOnly, adminContest.deleteContest);

router.get("/support/conversations", ...adminPanelRead, adminSupport.listConversations);
router.get("/support/conversations/:conversationId/messages", ...adminPanelRead, adminSupport.getConversationMessages);
router.patch("/support/messages/:messageId/status", ...manageContent, adminSupport.updateMessageStatus);

/** Student-of-the-month (IST) — admin / super_admin only (badge studio UI is not on instructor shell) */
router.get("/leaderboard-monthly-badges", ...adminPanelRead, adminMonthlyLeaderboard.listMonthlyBadges);
router.post("/leaderboard-monthly-badges/finalize-recent", ...manageContent, adminMonthlyLeaderboard.finalizeRecentMonthlyBadges);

/** Arena quest / IST streak milestones (distinct accepted questions per batch catalog) */
router.get("/student-milestone-badges", ...adminPanelRead, adminStudentAchievements.listMilestoneAchievementBadges);

/** Admin-authored achievement badges (draft / publish + auto-award Arena rules) */
router.get("/badge-programs", ...adminPanelRead, adminBadgeProgram.list);
router.get("/badge-programs/:id", ...adminPanelRead, adminBadgeProgram.getOne);
router.post("/badge-programs", ...manageContent, adminBadgeProgram.create);
router.patch("/badge-programs/:id", ...manageContent, adminBadgeProgram.patch);
router.delete("/badge-programs/:id", ...manageContent, adminBadgeProgram.remove);
router.post("/badge-programs/:id/reaward", ...manageContent, adminBadgeProgram.reawardPublished);

/** Legacy styling catalog for built-in milestone codes */
router.get("/badge-definitions/catalog", ...adminPanelRead, adminBadgeDefinitions.listCatalog);
router.patch("/badge-definitions/:badgeCode", ...manageContent, adminBadgeDefinitions.patchDefinition);

router.get("/todos", ...adminOnly, adminTodo.listTasks);
router.post("/todos", ...adminOnly, adminTodo.createTask);
router.patch("/todos/reorder", ...adminOnly, adminTodo.reorderTasks);
router.patch("/todos/:id", ...adminOnly, adminTodo.updateTask);
router.delete("/todos/:id", ...adminOnly, adminTodo.deleteTask);

module.exports = router;
