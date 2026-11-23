# API route table

Generated from `src/routes/modules/*.js` + mount order in `src/routes/index.js` (all mounted under `/v1` by `src/app.js`). **256 routes** in 21 route files, plus 3 routes defined directly in `src/app.js` (2 health, 1 webhook).

Legend: roles `SA` = super_admin, `A` = admin, `I` = instructor, `M` = mentor (see `src/utils/rbac.js`). `requireStaffAuth` also does the token_version / is_active revocation check. "upload" = route runs the multer middleware (`src/middlewares/upload.middleware.js`). Handler is `controllerFile.exportName` (`src/controllers/<controllerFile>.controller.js`). Some controllers apply extra scoping inside the handler (e.g. instructors restricted to their batches); this table shows route-level guards only.

Notes:
- `admin.routes` and `admin-billing.routes` both mount at `/v1/admin`; `student.routes` and `student-billing.routes` both mount at `/v1/students`. First match wins in mount order (`index.js`): `/staff` (staff-management) is mounted before `/staff/panel-notifications`.
- Admin billing routes use SA-only guard (`adminOnly` in `admin-billing.routes.js`), whereas `adminOnly` in `admin.routes.js` means SA + A.
- Rate limits: global 200 req/min/IP on everything after the webhook; 5/min on paths under `/v1/auth/otp` and `/v1/staff-auth/otp` only (`/otp/send`, `/otp/verify`); `/password/otp/send` etc. are NOT under that prefix and only get the global limit.

## Routes defined in `src/app.js`

| Method | Path | Auth | Handler |
|---|---|---|---|
| POST | /v1/payments/webhook/phonepe | public (PhonePe signature verified in handler; raw body, mounted before `express.json`, before rate limiter and DB-connect middleware) | payments-webhook.handlePhonepeWebhook |
| GET | /health | public | inline (always 200 `{status:"ok"}`) |
| GET | /health/db | public | inline (pings MongoDB; 503 `DB_NOT_CONNECTED` / `DB_PING_FAILED`) |

## auth.routes.js  (mount `/v1/auth`, 12 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| POST | `/v1/auth/otp/send` | public | `auth.sendOtp` |
| POST | `/v1/auth/password/otp/send` | public | `auth.sendForgotPasswordOtp` |
| POST | `/v1/auth/otp/verify` | public | `auth.verifyOtp` |
| POST | `/v1/auth/login` | public | `auth.loginWithPassword` |
| POST | `/v1/auth/signup/otp/verify` | public | `auth.verifySignupOtp` |
| POST | `/v1/auth/signup/password` | public | `auth.setPasswordFromSignup` |
| POST | `/v1/auth/password/otp/verify` | public | `auth.verifyPasswordResetOtp` |
| POST | `/v1/auth/password/reset` | public | `auth.resetPasswordWithToken` |
| POST | `/v1/auth/google` | public | `auth.googleLogin` |
| POST | `/v1/auth/refresh` | public | `auth.refreshToken` |
| POST | `/v1/auth/logout` | requireAuth | `auth.logout` |
| GET | `/v1/auth/me` | requireAuth | `auth.me` |

## staff-auth.routes.js  (mount `/v1/staff-auth`, 15 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| POST | `/v1/staff-auth/otp/send` | public | `staff-auth.sendOtp` |
| POST | `/v1/staff-auth/password/otp/send` | public | `staff-auth.sendForgotPasswordOtp` |
| POST | `/v1/staff-auth/otp/verify` | public | `staff-auth.verifyOtp` |
| POST | `/v1/staff-auth/login` | public | `staff-auth.loginWithPassword` |
| POST | `/v1/staff-auth/signup/otp/verify` | public | `staff-auth.verifySignupOtp` |
| POST | `/v1/staff-auth/signup/password` | public | `staff-auth.setPasswordFromSignup` |
| POST | `/v1/staff-auth/password/otp/verify` | public | `staff-auth.verifyForgotPasswordOtp` |
| POST | `/v1/staff-auth/password/reset` | public | `staff-auth.resetPassword` |
| POST | `/v1/staff-auth/me/password/otp/send` | requireStaffAuth (any role) | `staff-auth.sendMePasswordUpdateOtp` |
| POST | `/v1/staff-auth/me/password/otp/verify` | requireStaffAuth (any role) | `staff-auth.verifyMePasswordUpdateOtp` |
| POST | `/v1/staff-auth/me/password/otp/update` | requireStaffAuth (any role) | `staff-auth.updateMyPasswordWithOtp` |
| POST | `/v1/staff-auth/me/password/verify` | requireStaffAuth + A/SA | `staff-auth.verifyMyPassword` |
| POST | `/v1/staff-auth/refresh` | public | `staff-auth.refreshToken` |
| POST | `/v1/staff-auth/logout` | requireStaffAuth (any role) | `staff-auth.logout` |
| GET | `/v1/staff-auth/me` | requireStaffAuth (any role) | `staff-auth.me` |

## staff-management.routes.js  (mount `/v1/staff`, 23 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/staff/doubts/personal` | requireStaffAuth + SA/A/I/M | `staff-doubts.listPersonal` |
| PATCH | `/v1/staff/doubts/personal/:id/answer` | requireStaffAuth + SA/A/I/M | `staff-doubts.answerPersonal` (upload) |
| GET | `/v1/staff/doubts/community` | requireStaffAuth + SA/A/I/M | `staff-doubts.listCommunity` |
| POST | `/v1/staff/doubts/community` | requireStaffAuth + SA/A/I/M | `staff-doubts.postCommunity` (upload) |
| PATCH | `/v1/staff/doubts/community/:id/hide` | requireStaffAuth + SA/A | `staff-doubts.hideCommunity` |
| DELETE | `/v1/staff/doubts/community/:id` | requireStaffAuth + SA/A | `staff-doubts.deleteCommunity` |
| GET | `/v1/staff/directory/instructors` | requireStaffAuth + SA/A/I | `staff-management.listTimetableInstructors` |
| GET | `/v1/staff/profile/me` | requireStaffAuth (any role) | `staff-management.getMyProfile` |
| PUT | `/v1/staff/profile/me` | requireStaffAuth (any role) | `staff-management.updateMyProfile` |
| POST | `/v1/staff/profile/upload/profile-image` | requireStaffAuth (any role) | `staff-management.uploadOwnProfileImage` (upload) |
| POST | `/v1/staff/profile/upload/resume` | requireStaffAuth (any role) | `staff-management.uploadOwnResume` (upload) |
| GET | `/v1/staff/profiles/incomplete` | requireStaffAuth + SA/A | `staff-management.listIncompleteProfiles` |
| POST | `/v1/staff/profiles/bulk-update` | requireStaffAuth + SA/A | `staff-management.bulkUpdateProfiles` |
| GET | `/v1/staff/profile/:id` | requireStaffAuth + SA/A | `staff-management.getProfileById` |
| PATCH | `/v1/staff/profile/:id` | requireStaffAuth + SA/A | `staff-management.adminOverrideProfile` |
| POST | `/v1/staff/profile/:id/upload/profile-image` | requireStaffAuth + SA/A | `staff-management.uploadAdminProfileImage` (upload) |
| POST | `/v1/staff/profile/:id/upload/resume` | requireStaffAuth + SA/A | `staff-management.uploadAdminResume` (upload) |
| GET | `/v1/staff` | requireStaffAuth + SA/A | `staff-management.listStaff` |
| POST | `/v1/staff` | requireStaffAuth + SA/A | `staff-management.createStaff` |
| POST | `/v1/staff/:id/reset-password` | requireStaffAuth + SA | `staff-management.resetPassword` |
| PATCH | `/v1/staff/:id/active` | requireStaffAuth + SA | `staff-management.setActive` |
| PATCH | `/v1/staff/:id` | requireStaffAuth + SA/A | `staff-management.updateStaff` |
| DELETE | `/v1/staff/:id` | requireStaffAuth + SA | `staff-management.deleteStaff` |

## student.routes.js  (mount `/v1/students`, 10 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/students/me/achievements` | requireAuth | `student-achievement.combinedAchievements` |
| POST | `/v1/students/me/avatar` | requireAuth | `student.uploadAvatar` (upload) |
| POST | `/v1/students/me/password/otp/send` | requireAuth | `student.sendPasswordUpdateOtp` |
| POST | `/v1/students/me/password/otp/verify` | requireAuth | `student.verifyPasswordUpdateOtp` |
| POST | `/v1/students/me/password/otp/update` | requireAuth | `student.updatePasswordWithOtp` |
| GET | `/v1/students/me` | requireAuth | `student.getMe` |
| PATCH | `/v1/students/me` | requireAuth | `student.patchMe` |
| GET | `/v1/students/subjects` | requireAuth | `student.subjects` |
| GET | `/v1/students/scorecard/tests` | requireAuth | `student-scorecard.listActiveScorecardTests` |
| GET | `/v1/students/scorecard/records` | requireAuth | `student-scorecard.listMyScorecardRecords` |

## student-billing.routes.js  (mount `/v1/students`, 6 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/students/courses` | requireAuth | `student-courses.listMyCourses` |
| GET | `/v1/students/courses/:enrollmentId` | requireAuth | `student-courses.getMyCourseDetail` |
| GET | `/v1/students/payments/config` | requireAuth | `student-payments.getPaymentConfig` |
| POST | `/v1/students/payments/initiate` | requireAuth | `student-payments.initiatePayment` |
| GET | `/v1/students/payments/status/:merchantTxnId` | requireAuth | `student-payments.getPaymentStatus` |
| POST | `/v1/students/payments/manual` | requireAuth | `student-payments.submitManualPayment` (upload) |

## dashboard.routes.js  (mount `/v1/dashboard`, 2 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/dashboard/summary` | requireAuth | `dashboard.summary` |
| GET | `/v1/dashboard/home` | requireAuth | `dashboard.home` |

## notes.routes.js  (mount `/v1/notes`, 4 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/notes` | requireAuth | `notes.list` |
| GET | `/v1/notes/filters` | requireAuth | `notes.filters` |
| GET | `/v1/notes/:noteId` | requireAuth | `notes.detail` |
| GET | `/v1/notes/:noteId/download` | requireAuth | `notes.download` |

## assignment.routes.js  (mount `/v1/assignments`, 6 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/assignments` | requireAuth | `assignment.list` |
| GET | `/v1/assignments/filters` | requireAuth | `assignment.filters` |
| GET | `/v1/assignments/:assignmentId/questions/:questionId` | requireAuth | `assignment.questionDetail` |
| POST | `/v1/assignments/:assignmentId/questions/:questionId/run` | requireAuth | `assignment.run` |
| POST | `/v1/assignments/:assignmentId/questions/:questionId/submit` | requireAuth | `assignment.submit` |
| GET | `/v1/assignments/:assignmentId/questions/:questionId/submissions` | requireAuth | `assignment.submissions` |

## arena.routes.js  (mount `/v1/arena`, 7 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/arena/activity` | requireAuth | `arena.activity` |
| GET | `/v1/arena/solved` | requireAuth | `arena.solved` |
| GET | `/v1/arena/questions` | requireAuth | `arena.list` |
| GET | `/v1/arena/questions/:questionId` | requireAuth | `arena.detail` |
| POST | `/v1/arena/questions/:questionId/submit` | requireAuth | `arena.submit` |
| GET | `/v1/arena/questions/:questionId/submissions` | requireAuth | `arena.submissions` |
| POST | `/v1/arena/submit` | requireAuth | `arena.submit` |

## contest.routes.js  (mount `/v1/contests`, 2 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/contests` | requireAuth | `contest.listMyContests` |
| GET | `/v1/contests/:id` | requireAuth | `contest.getMyContest` |

## timetable.routes.js  (mount `/v1/timetable`, 2 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/timetable/weekly` | requireAuth | `timetable.weekly` |
| GET | `/v1/timetable/events` | requireAuth | `timetable.events` |

## admin.routes.js  (mount `/v1/admin`, 105 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/admin/announcements` | requireStaffAuth + SA/A/I | `admin-content.listAnnouncements` |
| POST | `/v1/admin/announcements` | requireStaffAuth + SA/A/I | `admin-content.createAnnouncement` |
| GET | `/v1/admin/announcements/:id` | requireStaffAuth + SA/A/I | `admin-content.getAnnouncement` |
| PATCH | `/v1/admin/announcements/:id` | requireStaffAuth + SA/A/I | `admin-content.updateAnnouncement` |
| DELETE | `/v1/admin/announcements/:id` | requireStaffAuth + SA/A/I | `admin-content.deleteAnnouncement` |
| GET | `/v1/admin/notes` | requireStaffAuth + SA/A/I | `admin-content.listNotes` |
| POST | `/v1/admin/notes` | requireStaffAuth + SA/A/I | `admin-content.createNote` |
| GET | `/v1/admin/notes/:id` | requireStaffAuth + SA/A/I | `admin-content.getNote` |
| PATCH | `/v1/admin/notes/:id` | requireStaffAuth + SA/A/I | `admin-content.updateNote` |
| DELETE | `/v1/admin/notes/:id` | requireStaffAuth + SA/A/I | `admin-content.deleteNote` |
| POST | `/v1/admin/uploads/note-asset` | requireStaffAuth + SA/A/I | `admin-upload.uploadNoteAsset` (upload) |
| POST | `/v1/admin/uploads/assignment-asset` | requireStaffAuth + SA/A/I | `admin-upload.uploadAssignmentAsset` (upload) |
| POST | `/v1/admin/uploads/assignment-question-asset` | requireStaffAuth + SA/A/I | `admin-upload.uploadAssignmentQuestionAsset` (upload) |
| POST | `/v1/admin/uploads/badge-program-art` | requireStaffAuth + SA/A | `admin-upload.uploadBadgeProgramArt` (upload) |
| GET | `/v1/admin/assignments/:assignmentId/questions/:questionId` | requireStaffAuth + SA/A/I | `admin-catalog.getAssignmentQuestion` |
| PATCH | `/v1/admin/assignments/:assignmentId/questions/:questionId` | requireStaffAuth + SA/A/I | `admin-catalog.updateAssignmentQuestion` |
| DELETE | `/v1/admin/assignments/:assignmentId/questions/:questionId` | requireStaffAuth + SA/A/I | `admin-catalog.deleteAssignmentQuestion` |
| GET | `/v1/admin/assignments/:assignmentId/questions` | requireStaffAuth + SA/A/I | `admin-catalog.listAssignmentQuestions` |
| POST | `/v1/admin/assignments/:assignmentId/questions` | requireStaffAuth + SA/A/I | `admin-catalog.createAssignmentQuestion` |
| GET | `/v1/admin/assignments/:assignmentId/project-submissions` | requireStaffAuth + SA/A/I | `admin-project-review.listProjectSubmissions` |
| GET | `/v1/admin/assignments/:assignmentId/project-submissions/:submissionId` | requireStaffAuth + SA/A/I | `admin-project-review.getProjectSubmission` |
| PATCH | `/v1/admin/assignments/:assignmentId/project-submissions/:submissionId/evaluation` | requireStaffAuth + SA/A/I | `admin-project-review.evaluateProjectSubmission` |
| POST | `/v1/admin/web-checks/verify` | requireStaffAuth + SA/A/I | `admin-catalog.verifyWebChecks` |
| POST | `/v1/admin/assignments/:id/project-publish` | requireStaffAuth + SA/A/I | `admin-catalog.publishProjectAssignment` |
| POST | `/v1/admin/assignments/:id/project-unpublish` | requireStaffAuth + SA/A/I | `admin-catalog.unpublishProjectAssignment` |
| GET | `/v1/admin/assignments` | requireStaffAuth + SA/A/I | `admin-catalog.listAssignments` |
| POST | `/v1/admin/assignments` | requireStaffAuth + SA/A/I | `admin-catalog.createAssignment` |
| GET | `/v1/admin/assignments/:id` | requireStaffAuth + SA/A/I | `admin-catalog.getAssignment` |
| PATCH | `/v1/admin/assignments/:id` | requireStaffAuth + SA/A/I | `admin-catalog.updateAssignment` |
| DELETE | `/v1/admin/assignments/:id` | requireStaffAuth + SA/A/I | `admin-catalog.deleteAssignment` |
| GET | `/v1/admin/arena/questions` | requireStaffAuth + SA/A/I | `admin-catalog.listArenaQuestions` |
| POST | `/v1/admin/arena/questions` | requireStaffAuth + SA/A | `admin-catalog.createArenaQuestion` |
| GET | `/v1/admin/arena/questions/:id` | requireStaffAuth + SA/A/I | `admin-catalog.getArenaQuestion` |
| PATCH | `/v1/admin/arena/questions/:id` | requireStaffAuth + SA/A | `admin-catalog.updateArenaQuestion` |
| DELETE | `/v1/admin/arena/questions/:id` | requireStaffAuth + SA/A | `admin-catalog.deleteArenaQuestion` |
| GET | `/v1/admin/timetable/slots` | requireStaffAuth + SA/A/I | `admin-catalog.listTimetableSlots` |
| GET | `/v1/admin/timetable/schedule` | requireStaffAuth + SA/A/I | `admin-catalog.listTimetableSchedule` |
| GET | `/v1/admin/timetable/google-meet/status` | requireStaffAuth + SA/A | `admin-catalog.googleMeetCalendarStatus` |
| POST | `/v1/admin/timetable/google-meet` | requireStaffAuth + SA/A | `admin-catalog.provisionTimetableGoogleMeet` |
| POST | `/v1/admin/timetable/slots` | requireStaffAuth + SA/A | `admin-catalog.createTimetableSlot` |
| GET | `/v1/admin/timetable/slots/:id` | requireStaffAuth + SA/A/I | `admin-catalog.getTimetableSlot` |
| PATCH | `/v1/admin/timetable/slots/:id` | requireStaffAuth + SA/A | `admin-catalog.updateTimetableSlot` |
| DELETE | `/v1/admin/timetable/slots/:id` | requireStaffAuth + SA/A | `admin-catalog.deleteTimetableSlot` |
| GET | `/v1/admin/timetable/events` | requireStaffAuth + SA/A/I | `admin-catalog.listTimetableEvents` |
| POST | `/v1/admin/timetable/events` | requireStaffAuth + SA/A | `admin-catalog.createTimetableEvent` |
| GET | `/v1/admin/timetable/events/:id` | requireStaffAuth + SA/A/I | `admin-catalog.getTimetableEvent` |
| PATCH | `/v1/admin/timetable/events/:id` | requireStaffAuth + SA/A | `admin-catalog.updateTimetableEvent` |
| DELETE | `/v1/admin/timetable/events/:id` | requireStaffAuth + SA/A | `admin-catalog.deleteTimetableEvent` |
| GET | `/v1/admin/mentor-slots` | requireStaffAuth + SA/A | `admin-catalog.listMentorSlotsAdmin` |
| GET | `/v1/admin/mentor-slots/mine` | requireStaffAuth + M | `admin-catalog.listMentorSlotsMine` |
| POST | `/v1/admin/mentor-slots` | requireStaffAuth + SA/A | `admin-catalog.createMentorSlot` |
| GET | `/v1/admin/mentor-slots/:id` | requireStaffAuth + SA/A | `admin-catalog.getMentorSlot` |
| PATCH | `/v1/admin/mentor-slots/:id` | requireStaffAuth + SA/A | `admin-catalog.updateMentorSlot` |
| DELETE | `/v1/admin/mentor-slots/:id` | requireStaffAuth + SA/A | `admin-catalog.deleteMentorSlot` |
| GET | `/v1/admin/batches` | requireStaffAuth + SA/A/I/M | `admin-batch-catalog.list` |
| POST | `/v1/admin/batches` | requireStaffAuth + SA/A | `admin-batch-catalog.create` |
| GET | `/v1/admin/batches/:batch_id/students` | requireStaffAuth + SA/A | `admin-batch-catalog.listStudentsInBatch` |
| GET | `/v1/admin/batches/:batch_id` | requireStaffAuth + SA/A | `admin-batch-catalog.getOne` |
| PATCH | `/v1/admin/batches/:batch_id` | requireStaffAuth + SA/A | `admin-batch-catalog.update` |
| DELETE | `/v1/admin/batches/:batch_id` | requireStaffAuth + SA/A | `admin-batch-catalog.remove` |
| GET | `/v1/admin/students` | requireStaffAuth + SA/A/I | `admin.listStudents` |
| GET | `/v1/admin/students/lookup` | requireStaffAuth + SA/A | `admin.lookupStudentByEmail` |
| GET | `/v1/admin/students/next-enrollment` | requireStaffAuth + SA/A | `admin.nextEnrollmentNumber` |
| POST | `/v1/admin/students` | requireStaffAuth + SA/A | `admin.createStudent` |
| GET | `/v1/admin/students/:id` | requireStaffAuth + SA/A/I | `admin.getStudent` |
| PATCH | `/v1/admin/students/:id` | requireStaffAuth + SA/A | `admin.updateStudent` |
| POST | `/v1/admin/students/:id/batches` | requireStaffAuth + SA/A | `admin.addStudentBatch` |
| DELETE | `/v1/admin/students/:id/batches/:batch_id` | requireStaffAuth + SA/A | `admin.removeStudentBatch` |
| POST | `/v1/admin/students/:id/avatar` | requireStaffAuth + SA/A | `admin.uploadStudentAvatar` (upload) |
| DELETE | `/v1/admin/students/:id` | requireStaffAuth + SA/A | `admin.deleteStudent` |
| GET | `/v1/admin/scorecard/entries` | requireStaffAuth + SA/A/I | `admin-scorecard.listEntries` |
| POST | `/v1/admin/scorecard/entries` | requireStaffAuth + SA/A | `admin-scorecard.createEntry` |
| POST | `/v1/admin/scorecard/entries/bulk` | requireStaffAuth + SA/A | `admin-scorecard.bulkCreateEntries` |
| GET | `/v1/admin/scorecard/spreadsheet-students` | requireStaffAuth + SA/A/I | `admin-scorecard.spreadsheetStudents` |
| POST | `/v1/admin/scorecard/entries/batch-save` | requireStaffAuth + SA/A | `admin-scorecard.batchSaveEntries` |
| POST | `/v1/admin/scorecard/entries/bulk-by-cst` | requireStaffAuth + SA/A | `admin-scorecard.bulkCreateByCst` |
| PATCH | `/v1/admin/scorecard/entries/:id` | requireStaffAuth + SA/A | `admin-scorecard.patchEntry` |
| DELETE | `/v1/admin/scorecard/entries/:id` | requireStaffAuth + SA/A | `admin-scorecard.deleteEntry` |
| GET | `/v1/admin/scorecard/records` | requireStaffAuth + SA/A/I | `admin-scorecard.listRecords` |
| GET | `/v1/admin/scorecard/summary` | requireStaffAuth + SA/A/I | `admin-scorecard.scorecardSummary` |
| GET | `/v1/admin/scorecard/tests` | requireStaffAuth + SA/A/I | `admin-scorecard.listTests` |
| POST | `/v1/admin/scorecard/tests` | requireStaffAuth + SA/A | `admin-scorecard.createTest` |
| PATCH | `/v1/admin/scorecard/tests/:id` | requireStaffAuth + SA/A | `admin-scorecard.patchTest` |
| DELETE | `/v1/admin/scorecard/tests/:id` | requireStaffAuth + SA/A | `admin-scorecard.deleteTest` |
| POST | `/v1/admin/scorecard/tests/:id/mark-absent-zero` | requireStaffAuth + SA/A | `admin-scorecard.markAbsentAsZero` |
| GET | `/v1/admin/contests` | requireStaffAuth + SA/A/I | `admin-contest.listContests` |
| POST | `/v1/admin/contests` | requireStaffAuth + SA/A | `admin-contest.createContest` |
| POST | `/v1/admin/contests/bulk` | requireStaffAuth + SA/A | `admin-contest.bulkCreateContests` |
| GET | `/v1/admin/contests/:id` | requireStaffAuth + SA/A/I | `admin-contest.getContest` |
| PATCH | `/v1/admin/contests/:id` | requireStaffAuth + SA/A | `admin-contest.patchContest` |
| DELETE | `/v1/admin/contests/:id` | requireStaffAuth + SA/A | `admin-contest.deleteContest` |
| GET | `/v1/admin/support/conversations` | requireStaffAuth + SA/A | `admin-support.listConversations` |
| GET | `/v1/admin/support/conversations/:conversationId/messages` | requireStaffAuth + SA/A | `admin-support.getConversationMessages` |
| PATCH | `/v1/admin/support/messages/:messageId/status` | requireStaffAuth + SA/A | `admin-support.updateMessageStatus` |
| GET | `/v1/admin/badge-programs` | requireStaffAuth + SA/A | `admin-badge-program.list` |
| GET | `/v1/admin/badge-programs/:id` | requireStaffAuth + SA/A | `admin-badge-program.getOne` |
| POST | `/v1/admin/badge-programs` | requireStaffAuth + SA/A | `admin-badge-program.create` |
| PATCH | `/v1/admin/badge-programs/:id` | requireStaffAuth + SA/A | `admin-badge-program.patch` |
| DELETE | `/v1/admin/badge-programs/:id` | requireStaffAuth + SA/A | `admin-badge-program.remove` |
| POST | `/v1/admin/badge-programs/:id/reaward` | requireStaffAuth + SA/A | `admin-badge-program.reawardPublished` |
| GET | `/v1/admin/todos` | requireStaffAuth + SA/A | `admin-todo.listTasks` |
| POST | `/v1/admin/todos` | requireStaffAuth + SA/A | `admin-todo.createTask` |
| PATCH | `/v1/admin/todos/reorder` | requireStaffAuth + SA/A | `admin-todo.reorderTasks` |
| PATCH | `/v1/admin/todos/:id` | requireStaffAuth + SA/A | `admin-todo.updateTask` |
| DELETE | `/v1/admin/todos/:id` | requireStaffAuth + SA/A | `admin-todo.deleteTask` |

## admin-billing.routes.js  (mount `/v1/admin`, 28 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/admin/courses` | requireStaffAuth + SA | `admin-courses.listCourses` |
| GET | `/v1/admin/courses/:id` | requireStaffAuth + SA | `admin-courses.getCourse` |
| POST | `/v1/admin/courses` | requireStaffAuth + SA | `admin-courses.createCourse` |
| PATCH | `/v1/admin/courses/:id` | requireStaffAuth + SA | `admin-courses.updateCourse` |
| DELETE | `/v1/admin/courses/:id` | requireStaffAuth + SA | `admin-courses.deleteCourse` |
| GET | `/v1/admin/enrollments` | requireStaffAuth + SA | `admin-enrollments.listEnrollments` |
| GET | `/v1/admin/enrollments/reconcile` | requireStaffAuth + SA | `admin-enrollments.reconcileEnrollments` |
| POST | `/v1/admin/enrollments/reconcile` | requireStaffAuth + SA | `admin-enrollments.reconcileEnrollments` |
| GET | `/v1/admin/enrollments/:id` | requireStaffAuth + SA | `admin-enrollments.getEnrollment` |
| POST | `/v1/admin/enrollments` | requireStaffAuth + SA | `admin-enrollments.createEnrollment` |
| PATCH | `/v1/admin/enrollments/:id` | requireStaffAuth + SA | `admin-enrollments.updateEnrollment` |
| DELETE | `/v1/admin/enrollments/:id` | requireStaffAuth + SA | `admin-enrollments.deleteEnrollment` |
| POST | `/v1/admin/enrollments/:id/transition` | requireStaffAuth + SA | `admin-enrollments.transitionEnrollment` |
| GET | `/v1/admin/invoices` | requireStaffAuth + SA | `admin-invoices.listInvoices` |
| GET | `/v1/admin/invoices/:id` | requireStaffAuth + SA | `admin-invoices.getInvoice` |
| POST | `/v1/admin/invoices` | requireStaffAuth + SA | `admin-invoices.createInvoice` |
| POST | `/v1/admin/invoices/bulk-generate` | requireStaffAuth + SA | `admin-invoices.bulkGenerateForCourse` |
| PATCH | `/v1/admin/invoices/:id` | requireStaffAuth + SA | `admin-invoices.patchInvoice` |
| DELETE | `/v1/admin/invoices/:id` | requireStaffAuth + SA | `admin-invoices.deleteInvoice` |
| GET | `/v1/admin/payments` | requireStaffAuth + SA | `admin-payments.listPayments` |
| GET | `/v1/admin/payments/config` | requireStaffAuth + SA | `admin-payments.getPaymentConfig` |
| GET | `/v1/admin/payments/reconciliation` | requireStaffAuth + SA | `admin-payments.reconciliation` |
| POST | `/v1/admin/payments/:id/refund` | requireStaffAuth + SA | `admin-payments.refundPayment` |
| GET | `/v1/admin/refunds` | requireStaffAuth + SA | `admin-payments.listRefunds` |
| GET | `/v1/admin/manual-payments` | requireStaffAuth + SA | `admin-manual-payments.listManualPayments` |
| PATCH | `/v1/admin/manual-payments/:id` | requireStaffAuth + SA | `admin-manual-payments.patchManualPaymentNote` |
| POST | `/v1/admin/manual-payments/:id/approve` | requireStaffAuth + SA | `admin-manual-payments.approveManualPayment` |
| POST | `/v1/admin/manual-payments/:id/reject` | requireStaffAuth + SA | `admin-manual-payments.rejectManualPayment` |

## leaderboard.routes.js  (mount `/v1/leaderboard`, 3 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/leaderboard/monthly-winners` | requireAuth | `monthly-leaderboard-badge.leaderboardMonthlyWinners` |
| GET | `/v1/leaderboard/me` | requireAuth | `leaderboard.me` |
| GET | `/v1/leaderboard` | requireAuth | `leaderboard.list` |

## mentor-sessions.routes.js  (mount `/v1/mentor-sessions`, 5 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/mentor-sessions/slots` | requireAuth | `mentor-sessions.listSlots` |
| GET | `/v1/mentor-sessions/me` | requireAuth | `mentor-sessions.mySessions` |
| POST | `/v1/mentor-sessions/slots/:slotId/book` | requireAuth | `mentor-sessions.book` |
| POST | `/v1/mentor-sessions/slots/:slotId/cancel` | requireAuth | `mentor-sessions.cancelBooking` |
| POST | `/v1/mentor-sessions/:sessionId/join` | requireAuth | `mentor-sessions.joinSession` |

## doubts.routes.js  (mount `/v1/doubts`, 6 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| POST | `/v1/doubts/personal` | requireAuth | `doubts.createPersonal` (upload) |
| GET | `/v1/doubts/subjects` | requireAuth | `doubts.listSubjects` |
| GET | `/v1/doubts/personal` | requireAuth | `doubts.listPersonal` |
| GET | `/v1/doubts/community/channels/:channelId/messages` | requireAuth | `doubts.listCommunityMessages` |
| POST | `/v1/doubts/community/channels/:channelId/messages` | requireAuth | `doubts.postCommunityMessage` (upload) |
| POST | `/v1/doubts/community/messages/:messageId/like` | requireAuth | `doubts.likeCommunityMessage` |

## support.routes.js  (mount `/v1/support`, 3 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| POST | `/v1/support/conversations` | requireAuth | `support.openOrResumeConversation` |
| GET | `/v1/support/conversations/:conversationId/messages` | requireAuth | `support.listMessages` |
| POST | `/v1/support/conversations/:conversationId/messages` | requireAuth | `support.sendMessage` (upload) |

## notifications.routes.js  (mount `/v1/notifications`, 4 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/notifications` | requireAuth | `notifications.list` |
| GET | `/v1/notifications/unread-count` | requireAuth | `notifications.unreadCount` |
| POST | `/v1/notifications/mark-all-read` | requireAuth | `notifications.markAllRead` |
| POST | `/v1/notifications/:id/read` | requireAuth | `notifications.markRead` |

## staff-panel-notifications.routes.js  (mount `/v1/staff/panel-notifications`, 9 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/staff/panel-notifications/me` | requireStaffAuth (any role) | `staff-panel-notifications.listMine` |
| GET | `/v1/staff/panel-notifications/me/unread-count` | requireStaffAuth (any role) | `staff-panel-notifications.unreadCount` |
| POST | `/v1/staff/panel-notifications/me/:id/read` | requireStaffAuth (any role) | `staff-panel-notifications.postReadOne` |
| POST | `/v1/staff/panel-notifications/me/mark-all-read` | requireStaffAuth (any role) | `staff-panel-notifications.postMarkAllRead` |
| POST | `/v1/staff/panel-notifications/me/clear-all` | requireStaffAuth (any role) | `staff-panel-notifications.postClearAll` |
| POST | `/v1/staff/panel-notifications` | requireStaffAuth + SA/A | `staff-panel-notifications.adminCreate` |
| GET | `/v1/staff/panel-notifications/admin` | requireStaffAuth + SA/A | `staff-panel-notifications.adminList` |
| PATCH | `/v1/staff/panel-notifications/admin/:id` | requireStaffAuth + SA/A | `staff-panel-notifications.adminPatch` |
| DELETE | `/v1/staff/panel-notifications/admin/:id` | requireStaffAuth + SA/A | `staff-panel-notifications.adminDelete` |

## internal.routes.js  (mount `/v1/internal`, 2 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/internal/cron/run` | public + CRON_SECRET | inline `run` (guarded by `authorizeCron`: `CRON_SECRET` via `x-cron-secret` header or `?key=`) |
| POST | `/v1/internal/cron/run` | public + CRON_SECRET | inline `run` (guarded by `authorizeCron`: `CRON_SECRET` via `x-cron-secret` header or `?key=`) |

## referral.routes.js  (mount `/v1/referral`, 2 routes)

| Method | Full path | Auth | Handler |
|---|---|---|---|
| GET | `/v1/referral/me` | requireAuth | `referral.me` |
| GET | `/v1/referral/events` | requireAuth | `referral.events` |

