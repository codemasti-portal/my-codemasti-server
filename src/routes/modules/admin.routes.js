const express = require("express");
const { requireStaffAuth, requireStaffRoles } = require("../../middlewares/staff.middleware");
const { ROLES } = require("../../utils/rbac");
const controller = require("../../controllers/admin.controller");
const content = require("../../controllers/admin-content.controller");
const catalog = require("../../controllers/admin-catalog.controller");
const batchCatalog = require("../../controllers/admin-batch-catalog.controller");
const adminUpload = require("../../controllers/admin-upload.controller");
const adminScorecard = require("../../controllers/admin-scorecard.controller");
const adminSupport = require("../../controllers/admin-support.controller");
const adminTodo = require("../../controllers/admin-todo.controller");
const uploadMw = require("../../middlewares/upload.middleware");

const router = express.Router();

const manageContent = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];
const manageNotes = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageLiveClasses = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageAssignments = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const readTimetable = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const manageTimetable = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];
const manageScorecard = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const batchCatalogRead = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.INSTRUCTOR])];
const adminOnly = [requireStaffAuth, requireStaffRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN])];

router.get("/announcements", ...manageContent, content.listAnnouncements);
router.post("/announcements", ...manageContent, content.createAnnouncement);
router.get("/announcements/:id", ...manageContent, content.getAnnouncement);
router.patch("/announcements/:id", ...manageContent, content.updateAnnouncement);
router.delete("/announcements/:id", ...manageContent, content.deleteAnnouncement);

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

router.get("/arena/questions", ...manageContent, catalog.listArenaQuestions);
router.post("/arena/questions", ...manageContent, catalog.createArenaQuestion);
router.get("/arena/questions/:id", ...manageContent, catalog.getArenaQuestion);
router.patch("/arena/questions/:id", ...manageContent, catalog.updateArenaQuestion);
router.delete("/arena/questions/:id", ...manageContent, catalog.deleteArenaQuestion);

router.get("/live-classes", ...manageLiveClasses, catalog.listLiveClasses);
router.post("/live-classes", ...manageLiveClasses, catalog.createLiveClass);
router.get("/live-classes/:id", ...manageLiveClasses, catalog.getLiveClass);
router.patch("/live-classes/:id", ...manageLiveClasses, catalog.updateLiveClass);
router.delete("/live-classes/:id", ...manageLiveClasses, catalog.deleteLiveClass);

router.get("/timetable/slots", ...readTimetable, catalog.listTimetableSlots);
router.post("/timetable/slots", ...manageTimetable, catalog.createTimetableSlot);
router.get("/timetable/slots/:id", ...readTimetable, catalog.getTimetableSlot);
router.patch("/timetable/slots/:id", ...manageTimetable, catalog.updateTimetableSlot);
router.delete("/timetable/slots/:id", ...manageTimetable, catalog.deleteTimetableSlot);

router.get("/timetable/events", ...readTimetable, catalog.listTimetableEvents);
router.post("/timetable/events", ...manageTimetable, catalog.createTimetableEvent);
router.get("/timetable/events/:id", ...readTimetable, catalog.getTimetableEvent);
router.patch("/timetable/events/:id", ...manageTimetable, catalog.updateTimetableEvent);
router.delete("/timetable/events/:id", ...manageTimetable, catalog.deleteTimetableEvent);

router.get("/mentor-slots", ...manageContent, catalog.listMentorSlotsAdmin);
router.post("/mentor-slots", ...manageContent, catalog.createMentorSlot);
router.get("/mentor-slots/:id", ...manageContent, catalog.getMentorSlot);
router.patch("/mentor-slots/:id", ...manageContent, catalog.updateMentorSlot);
router.delete("/mentor-slots/:id", ...manageContent, catalog.deleteMentorSlot);

router.get("/batches", ...batchCatalogRead, batchCatalog.list);
router.post("/batches", ...manageContent, batchCatalog.create);
router.get("/batches/:batch_id/students", ...manageContent, batchCatalog.listStudentsInBatch);
router.get("/batches/:batch_id", ...manageContent, batchCatalog.getOne);
router.patch("/batches/:batch_id", ...manageContent, batchCatalog.update);
router.delete("/batches/:batch_id", ...manageContent, batchCatalog.remove);

router.get("/students", ...manageContent, controller.listStudents);
router.post("/students", ...manageContent, controller.createStudent);
router.get("/students/:id", ...manageContent, controller.getStudent);
router.patch("/students/:id", ...manageContent, controller.updateStudent);
router.post(
  "/students/:id/avatar",
  ...manageContent,
  uploadMw.adminStudentAvatarUpload,
  controller.uploadStudentAvatar
);
router.delete("/students/:id", ...manageContent, controller.deleteStudent);

router.get("/scorecard/config", ...manageScorecard, adminScorecard.getConfig);
router.put("/scorecard/config", ...manageScorecard, adminScorecard.updateConfig);
router.get("/scorecard/students/:studentId/months", ...manageScorecard, adminScorecard.listStudentMonths);
router.get("/scorecard/students/:studentId/:monthKey", ...manageScorecard, adminScorecard.getStudentMonth);
router.put("/scorecard/students/:studentId/:monthKey", ...manageScorecard, adminScorecard.upsertStudentMonth);
router.delete("/scorecard/students/:studentId/:monthKey", ...manageScorecard, adminScorecard.deleteStudentMonth);

router.get("/support/conversations", ...manageContent, adminSupport.listConversations);
router.get("/support/conversations/:conversationId/messages", ...manageContent, adminSupport.getConversationMessages);
router.patch("/support/messages/:messageId/status", ...manageContent, adminSupport.updateMessageStatus);

router.get("/todos", ...adminOnly, adminTodo.listTasks);
router.post("/todos", ...adminOnly, adminTodo.createTask);
router.patch("/todos/:id", ...adminOnly, adminTodo.updateTask);
router.delete("/todos/:id", ...adminOnly, adminTodo.deleteTask);

module.exports = router;

