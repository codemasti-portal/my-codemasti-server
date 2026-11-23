> STALE SNAPSHOT from 2026-05-27: covers 35 of the 42 models now in `src/models`. Regenerate before relying on it. Current model list: ../ARCHITECTURE.md section 9.

# CodeMasti — MongoDB Schema Audit

Generated: 2026-05-27
Server source scanned: my-codemasti-server/src/ (excluding models/)
MongoDB sampling: up to 200 docs per collection

## Legend

- **USED** — declared in schema AND referenced in server code outside the model
- **LOW-USAGE** — declared in schema with only 1–2 external references; worth inspecting (may be write-only / dead path)
- **MODEL-ONLY** — declared in schema but never read/written outside the model file
- **ORPHAN** — exists in MongoDB documents but NOT in the current schema (deprecated/removed)
- **META** — Mongoose-managed (`_id`, `__v`, timestamps)

## Summary

- Total collections (models): 35
- Total fields declared in schemas: 388
- Fields USED (≥3 external references, or generic name): 380
- Fields LOW-USAGE (1–2 external references — inspect for write-only / dead path): 8
- Fields MODEL-ONLY (zero external references — safe-to-remove): 0
- Fields ORPHAN in DB but not in schema: 1
- Orphan collections in DB without a Mongoose model: 2

### Collections in MongoDB without a Mongoose model

These collections exist in the DB but have no current Mongoose model. They are likely deprecated and ready to drop.

- `scorecardconfigs` — 1 docs — server-src references to name: 0 — fields: `_id`, `createdAt`, `key`, `scholarship_rules`, `test_names`, `updatedAt`
- `scorecardmonths` — 4 docs — server-src references to name: 0 — fields: `_id`, `createdAt`, `month_key`, `monthly_test`, `next_month_fee`, `student_id`, `subjects`, `tests`, `updatedAt`

### Top removal candidates

MODEL-ONLY fields first (zero external references — highest confidence), then LOW-USAGE fields (1–2 references — likely write-only / dead path; verify before removing).

| # | Status | Hits | Collection (docs) | Model | Field | Type | Notes |
|---|---|---|---|---|---|---|---|
| 1 | LOW-USAGE | 1 | `notifications` (829) | Notification | `email_to` | String | Email delivery audit |
| 2 | LOW-USAGE | 1 | `assignmentsubmissions` (795) | AssignmentSubmission | `evaluator_raw` | String | — |
| 3 | LOW-USAGE | 1 | `assignmentxpgrants` (593) | AssignmentXpGrant | `source_submission_id` | ObjectId(AssignmentSubmission) | — |
| 4 | LOW-USAGE | 1 | `communitymessages` (3) | CommunityMessage | `hidden_at` | Date | — |
| 5 | LOW-USAGE | 1 | `communitymessages` (3) | CommunityMessage | `hidden_by_staff_id` | ObjectId(Staff) | — |
| 6 | LOW-USAGE | 2 | `notifications` (829) | Notification | `email_sent_at` | Date | — |
| 7 | LOW-USAGE | 2 | `assignmentxpgrants` (593) | AssignmentXpGrant | `submitted_before_deadline` | Boolean | — |
| 8 | LOW-USAGE | 2 | `classjoinaudits` (4) | ClassJoinAudit | `user_agent` | String | — |

## Per-collection breakdown

### AchievementBadgeDefinition (`AchievementBadgeDefinition.js`)

**Document count in DB:** 1 (sampled 1)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `accent` | String, enum | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `badge_code` | String, required, unique, lowercase | USED | Stable key wired to awarding logic. Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `category` | String, enum, required | USED | monthly_leaderboard \| arena_quests \| arena_streak — Generic name — usage matches likely cover this field |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `icon_key` | String, enum | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `is_published` | Boolean | USED | When false, automation falls back to defaults. Referenced in admin-badge-definition.controller.js, achievement-badge-definition.service.js |
| `sort_order` | Number | USED | Referenced in admin-badge-definition.controller.js, achievement-badge-definition.service.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |

**Indexes:** { category, sort_order, badge_code }

### AdminTodoTask (`AdminTodoTask.js`)

**Document count in DB:** 52 (sampled 52)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `created_by` | ObjectId(Staff), required, indexed | USED | Referenced in admin-todo.controller.js, staff-management.controller.js, staff-panel-notifications.controller.js |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `order` | Number | USED | Generic name — usage matches likely cover this field |
| `priority` | String, enum | USED | low \| mid \| high. Referenced in admin-todo.controller.js |
| `resolved_at` | Date | USED | Referenced in admin-todo.controller.js |
| `status` | String, enum, indexed | USED | pending \| in_progress \| resolved — Generic name — usage matches likely cover this field |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |
| `updated_by` | ObjectId(Staff) | USED | Referenced in admin-todo.controller.js |

**Indexes:** { status, priority, order, createdAt }

### Announcement (`Announcement.js`)

**Document count in DB:** 2 (sampled 2)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `batch` | String, indexed | USED | Display batch label. Referenced in achievement-badges.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `batch_id` | String, indexed | USED | Catalog batch id. Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `created_by_name` | String | USED | Referenced in announcementAuthor.js, admin-todo.controller.js, admin-content.controller.js |
| `created_by_role` | String, indexed | USED | Referenced in announcementAuthor.js, announcement.controller.js, admin-content.controller.js |
| `created_by_staff_id` | ObjectId(Staff), indexed | USED | Referenced in announcementAuthor.js, admin-content.controller.js |
| `date` | Date, indexed | USED | Schedule future values — Generic name — usage matches likely cover this field |
| `description` | String, required | USED | Generic name — usage matches likely cover this field |
| `scope` | String, enum, indexed | USED | batch \| global. Referenced in instructorBatchScope.js, seed.js, announcement.controller.js |
| `section_ids` | [String] | USED | Normalized section ids. Referenced in announcement.controller.js, admin-content.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |

### ArenaQuestion (`ArenaQuestion.js`)

**Document count in DB:** 130 (sampled 130)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `acceptance_rate` | Number | USED | Referenced in seed.js, admin-catalog.controller.js, arena.controller.js |
| `batch_id` | String, indexed, lowercase | USED | Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `batch_ids` | [String], indexed | USED | Multi-batch tagging. Referenced in assignmentBatchFilter.js, instructorBatchScope.js, backfill-instructor-batches-all-catalog.js |
| `constraints` | [String] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `description` | String, required | USED | Generic name — usage matches likely cover this field |
| `difficulty` | String, enum, indexed | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `examples` | [Mixed] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `hidden_tests` | [Mixed] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `input_format` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `is_disabled` | Boolean, indexed | USED | Referenced in admin-catalog.controller.js, arena.controller.js, admin.controller.js |
| `memory_limit` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `number` | Number, indexed | USED | Referenced in enrollment.js, seed.js, admin-scorecard.controller.js |
| `output_format` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `question_image_url` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `question_type` | String, enum, indexed | USED | quiz \| coding \| written. Referenced in admin-catalog.controller.js, arena.controller.js |
| `quiz_options` | [{text,image_url,is_correct}] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `requirements` | [String] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `starter_code` | subdoc {python,javascript,java,cpp} | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `subject` | String, indexed | USED | Generic name — usage matches likely cover this field |
| `time_limit` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |
| `topic` | String, indexed | USED | Generic name — usage matches likely cover this field |
| `xp` | Number | USED | Referenced in seed.js, student-achievement.controller.js, leaderboard.controller.js |

### ArenaSubmission (`ArenaSubmission.js`)

**Document count in DB:** 332 (sampled 200)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `code` | String, required | USED | Generic name — usage matches likely cover this field |
| `execution_time_ms` | Number | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `language` | String, required | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `memory_mb` | Number | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `question_id` | ObjectId(ArenaQuestion), required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `status` | String | USED | Generic name — usage matches likely cover this field |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `submitted_at` | Date | USED | Referenced in india-time.js, seed.js, leaderboard.controller.js |
| `test_cases_passed` | String | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `xp_credited` | Number, min 0 | USED | XP actually credited (0 if practice / wrong). Referenced in leaderboard.controller.js, arena.controller.js, admin.controller.js |

**Indexes:** { question_id, student_id, submitted_at }

### Assignment (`Assignment.js`)

**Document count in DB:** 20 (sampled 20)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `assignment_type` | String, enum, indexed | USED | quiz \| coding \| written \| project \| other. Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `batch_id` | String, indexed | USED | Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `batch_ids` | [String] | USED | Multi-batch tagging. Referenced in assignmentBatchFilter.js, instructorBatchScope.js, backfill-instructor-batches-all-catalog.js |
| `deadline_date` | Date, required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `module` | String, required, indexed | USED | Referenced in db.js, achievement-badges.js, batchDefaults.js |
| `release_date` | Date, required, indexed | USED | Referenced in assignmentBatchFilter.js, seed.js, admin-catalog.controller.js |
| `release_notification_sent_at` | Date, indexed | USED | Prevents duplicate release notifications. Referenced in assignment-release-notification.scheduler.js, assignment-notifications.service.js |
| `resource_size` | String | USED | Referenced in admin-catalog.controller.js, assignment.controller.js |
| `resource_url` | String | USED | Optional PDF / image / link. Referenced in admin-catalog.controller.js, assignment.controller.js |
| `section_id` | String, indexed | USED | Referenced in enrollment.js, seed.js, announcement.controller.js |
| `subject` | String, required, indexed | USED | Generic name — usage matches likely cover this field |
| `title` | String | USED | Generic name — usage matches likely cover this field |

### AssignmentQuestion (`AssignmentQuestion.js`)

**Document count in DB:** 234 (sampled 200)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `assignment_id` | ObjectId(Assignment), required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `constraints` | [String] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `description` | String, required | USED | Generic name — usage matches likely cover this field |
| `difficulty` | String, enum, indexed | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `examples` | [Mixed] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `execution_mode` | String, enum | USED | full_program \| function_only. Referenced in admin-catalog.controller.js, assignment.controller.js |
| `hidden_tests` | [Mixed] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `input_format` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `memory_limit` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `name` | String, required, indexed | USED | Generic name — usage matches likely cover this field |
| `output_format` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `question_image_url` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `quiz_options` | [{text,image_url,is_correct}] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `requirements` | [String] | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `starter_code` | subdoc {python,javascript,java,cpp} | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `time_limit` | String | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |
| `topics` | [String], indexed | USED | Referenced in seed.js, admin-catalog.controller.js, assignment.controller.js |
| `xp` | Number | USED | Referenced in seed.js, student-achievement.controller.js, leaderboard.controller.js |

### AssignmentSubmission (`AssignmentSubmission.js`)

**Document count in DB:** 795 (sampled 200)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `ai_feedback` | String | USED | Referenced in assignment.controller.js |
| `ai_score` | Number | USED | Referenced in assignment.controller.js |
| `assignment_id` | ObjectId(Assignment), required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `attempt_no` | Number, indexed | USED | Referenced in assignment.controller.js |
| `code` | String, required | USED | Generic name — usage matches likely cover this field |
| `evaluator_model` | String | USED | Referenced in assignment.controller.js |
| `evaluator_provider` | String | USED | Referenced in assignment.controller.js |
| `execution_time_ms` | Number | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `language` | String, required | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `memory_mb` | Number | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `question_id` | ObjectId(AssignmentQuestion), required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `status` | String, indexed | USED | Generic name — usage matches likely cover this field |
| `stderr` | String | USED | Referenced in assignment.controller.js, arena.controller.js, python-executor-local.js |
| `stdout` | String | USED | Referenced in assignment.controller.js, arena.controller.js, python-executor-local.js |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `submitted_at` | Date, indexed | USED | Referenced in india-time.js, seed.js, leaderboard.controller.js |
| `test_case_results` | [Mixed] | USED | Referenced in assignment.controller.js, deepseek-evaluator.js |
| `test_cases_passed` | String | USED | Referenced in seed.js, assignment.controller.js, arena.controller.js |
| `xp_awarded` | Number | USED | Full XP before deadline, half after. Referenced in leaderboard.controller.js, assignment.controller.js, arena.controller.js |
| `evaluator_raw` | String | LOW-USAGE | Only 1 ref(s) in: assignment.controller.js |

### AssignmentXpGrant (`AssignmentXpGrant.js`)

**Document count in DB:** 593 (sampled 200)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `assignment_id` | ObjectId(Assignment), required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `deadline_date` | Date | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `full_xp` | Number, required, min 0 | USED | Referenced in leaderboard.controller.js, assignment.controller.js, admin.controller.js |
| `granted_at` | Date, indexed | USED | Referenced in referralRewards.js, assignment.controller.js, admin.controller.js |
| `question_id` | ObjectId(AssignmentQuestion), required, indexed | USED | Referenced in seed.js, leaderboard.controller.js, admin-catalog.controller.js |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `submitted_at` | Date, required, indexed | USED | Referenced in india-time.js, seed.js, leaderboard.controller.js |
| `xp_awarded` | Number, required, min 0 | USED | Referenced in leaderboard.controller.js, assignment.controller.js, arena.controller.js |
| `source_submission_id` | ObjectId(AssignmentSubmission) | LOW-USAGE | Only 1 ref(s) in: assignment.controller.js |
| `submitted_before_deadline` | Boolean | LOW-USAGE | Only 2 ref(s) in: assignment.controller.js |

**Indexes:** uniq { assignment_id, question_id, student_id }

### BadgeProgram (`BadgeProgram.js`)

**Document count in DB:** 0 (no documents — orphan rows skipped)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `accent` | String, enum | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `award_rule_kind` | String, enum, required | USED | arena_distinct_solved \| arena_best_streak_ist \| assignment_monthly_ist_xp \| student_total_xp_milestone. Referenced in admin-badge-program.controller.js, badge-program.service.js |
| `award_rule_threshold` | Number, required, min 1 | USED | Referenced in admin-badge-program.controller.js, badge-program.service.js |
| `badge_code` | String, required, unique, lowercase | USED | Immutable slug. Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `badge_layout` | Mixed | USED | Draggable text overlay spec. Referenced in student-achievement.controller.js, admin-badge-program.controller.js, badge-program.service.js |
| `custom_image_url` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, badge-program.service.js |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `icon_key` | String, enum | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `monthly_custom_dom` | Number, 1-31 | USED | Referenced in admin-badge-program.controller.js, badge-program.service.js |
| `monthly_evaluation` | String, enum | USED | ist_auto \| ist_custom_dom. Referenced in admin-badge-program.controller.js, badge-program.service.js |
| `published_at` | Date | USED | Referenced in admin-badge-program.controller.js, badge-program.service.js |
| `status` | String, enum, indexed | USED | draft \| published — Generic name — usage matches likely cover this field |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |

**Indexes:** { status, updatedAt }

### BatchCatalog (`BatchCatalog.js`)

**Document count in DB:** 3 (sampled 3)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `batch_id` | String, required, unique, lowercase, indexed | USED | Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `name` | String, required | USED | Generic name — usage matches likely cover this field |
| `order` | Number | USED | Generic name — usage matches likely cover this field |
| `sections` | [{section_id,name,subjects:[String]}] | USED | Referenced in batchDefaults.js, seed.js, notes.controller.js |

### ClassJoinAudit (`ClassJoinAudit.js`)

**Document count in DB:** 4 (sampled 4)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `class_id` | ObjectId(LiveClass), required, indexed | USED | Referenced in seed.js, classes.controller.js |
| `ip_address` | String | USED | Referenced in seed.js, classes.controller.js |
| `joined_at` | Date, indexed | USED | Referenced in seed.js, mentor-sessions.controller.js, classes.controller.js |
| `source` | String | USED | Generic name — usage matches likely cover this field |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `user_agent` | String | LOW-USAGE | Only 2 ref(s) in: seed.js, classes.controller.js |

**Indexes:** { class_id, student_id, joined_at }

### CommunityMessage (`CommunityMessage.js`)

**Document count in DB:** 3 (sampled 3)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `author_name` | String | USED | Referenced in seed.js, staff-doubts.controller.js, doubts.controller.js |
| `author_role` | String, enum | USED | student \| instructor \| mentor \| admin \| super_admin. Referenced in staff-doubts.controller.js, doubts.controller.js |
| `channel_id` | String, required, indexed | USED | Referenced in seed.js, staff-doubts.controller.js, doubts.controller.js |
| `code` | subdoc {lang,content} | USED | Generic name — usage matches likely cover this field |
| `is_hidden` | Boolean, indexed | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |
| `likes` | [ObjectId(Student)] | USED | Referenced in seed.js, staff-doubts.controller.js, doubts.controller.js |
| `media` | subdoc {url,mime_type,file_name,bytes,kind} | USED | Generic name — usage matches likely cover this field |
| `staff_id` | ObjectId(Staff), indexed | USED | Referenced in staff-doubts.controller.js, doubts.controller.js, instructor-notifications.service.js |
| `student_id` | ObjectId(Student), indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `text` | String | USED | Generic name — usage matches likely cover this field |
| `hidden_at` | Date | LOW-USAGE | Only 1 ref(s) in: staff-doubts.controller.js |
| `hidden_by_staff_id` | ObjectId(Staff) | LOW-USAGE | Only 1 ref(s) in: staff-doubts.controller.js |

### LiveClass (`LiveClass.js`)

**Document count in DB:** 1 (sampled 1)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `batch_id` | String, indexed | USED | Legacy single-target id. Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `date` | String (YYYY-MM-DD), required, indexed | USED | Generic name — usage matches likely cover this field |
| `end_time` | String, required | USED | Referenced in seed.js, admin-catalog.controller.js, classes.controller.js |
| `instructor` | String, required | USED | Referenced in announcementAuthor.js, instructorBatchScope.js, rbac.js |
| `meet_link` | String, required | USED | Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `recording_link` | String | USED | Referenced in seed.js, admin-catalog.controller.js, timetable.controller.js |
| `start_time` | String, required | USED | Referenced in seed.js, admin-catalog.controller.js, classes.controller.js |
| `subject` | String, required, indexed | USED | Generic name — usage matches likely cover this field |
| `target_batch_ids` | [String] | USED | Multi-target batches. Referenced in instructorBatchScope.js, seed.js, notes.controller.js |
| `target_section_refs` | [{batch_id,section_id}] | USED | Referenced in instructorBatchScope.js, seed.js, notes.controller.js |
| `topic` | String, required | USED | Generic name — usage matches likely cover this field |

### MentorSessionJoin (`MentorSessionJoin.js`)

**Document count in DB:** 2 (sampled 2)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `joined_at` | Date | USED | Referenced in seed.js, mentor-sessions.controller.js, classes.controller.js |
| `slot_id` | ObjectId(MentorSlot), required, indexed | USED | Referenced in mentor-sessions.controller.js |
| `source` | String | USED | Generic name — usage matches likely cover this field |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |

**Indexes:** uniq { slot_id, student_id }

### MentorSlot (`MentorSlot.js`)

**Document count in DB:** 2 (sampled 2)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `booked_at` | Date | USED | Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `booked_by` | ObjectId(Student) | USED | Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `booking_state` | String, enum, indexed | USED | open \| booked \| cancelled. Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `date` | Date, required, indexed | USED | Generic name — usage matches likely cover this field |
| `duration_minutes` | Number, min 1 | USED | Generic name — usage matches likely cover this field |
| `meet_link` | String | USED | Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `meet_link_missing_alert_15m_sent_at` | Date, indexed | USED | Referenced in mentor-reminder.scheduler.js |
| `mentor_info` | String | USED | Referenced in admin-catalog.controller.js, mentor-sessions.controller.js |
| `mentor_name` | String, required | USED | Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `publish_date` | Date, indexed | USED | Referenced in admin-catalog.controller.js, mentor-sessions.controller.js, mentor-reminder.scheduler.js |
| `reminder_15m_sent_at` | Date, indexed | USED | Referenced in mentor-reminder.scheduler.js |
| `subject` | String, required | USED | Generic name — usage matches likely cover this field |
| `target_batch_ids` | [String, lowercase] | USED | Referenced in instructorBatchScope.js, seed.js, notes.controller.js |
| `target_section_ids` | [String, lowercase] | USED | Referenced in admin-catalog.controller.js, mentor-sessions.controller.js, mentor-reminder.scheduler.js |
| `target_student_ids` | [ObjectId(Student)] | USED | Referenced in admin-catalog.controller.js, mentor-sessions.controller.js |
| `time` | String, required | USED | Generic name — usage matches likely cover this field |

### MonthlyLeaderboardBadge (`MonthlyLeaderboardBadge.js`)

**Document count in DB:** 0 (no documents — orphan rows skipped)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `accent` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `avatar_url_snapshot` | String | USED | Referenced in student-achievement.controller.js, admin-monthly-leaderboard.controller.js, monthly-leaderboard-badge.controller.js |
| `badge_code` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `finalized_at` | Date | USED | Referenced in student-achievement.controller.js, admin-monthly-leaderboard.controller.js, monthly-leaderboard-badge.controller.js |
| `icon_key` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `period` | String, required, indexed | USED | IST month key YYYY-MM. Referenced in india-time.js, student-achievement.controller.js, admin-scorecard.controller.js |
| `scope_key` | String, required, indexed | USED | Normalized batch_id or solo:<studentId>. Referenced in student-achievement.controller.js, admin-monthly-leaderboard.controller.js, monthly-leaderboard-badge.controller.js |
| `student_id` | ObjectId(Student), required | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `student_name_snapshot` | String | USED | Referenced in student-achievement.controller.js, admin-monthly-leaderboard.controller.js, monthly-leaderboard-badge.controller.js |
| `title` | String | USED | Generic name — usage matches likely cover this field |
| `xp` | Number, required, min 0 | USED | Referenced in seed.js, student-achievement.controller.js, leaderboard.controller.js |

**Indexes:** uniq { period, scope_key }; { student_id, period }

### Note (`Note.js`)

**Document count in DB:** 1 (sampled 1)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `file_url` | String, required | USED | Referenced in seed.js, notes.controller.js, admin-content.controller.js |
| `module` | String, required, indexed | USED | Referenced in db.js, achievement-badges.js, batchDefaults.js |
| `sections` | [{title,points:[String]}] | USED | Referenced in batchDefaults.js, seed.js, notes.controller.js |
| `size` | String | USED | Generic name — usage matches likely cover this field |
| `subject` | String, required, indexed | USED | Generic name — usage matches likely cover this field |
| `summary` | String | USED | Referenced in seed.js, admin-badge-program.controller.js, notes.controller.js |
| `target_batch_ids` | [String] | USED | Referenced in instructorBatchScope.js, seed.js, notes.controller.js |
| `target_section_refs` | [{batch_id,section_id}] | USED | Referenced in instructorBatchScope.js, seed.js, notes.controller.js |
| `topic` | String, indexed | USED | Generic name — usage matches likely cover this field |
| `updated_date` | Date, indexed | USED | Referenced in seed.js, notes.controller.js, admin-content.controller.js |

### Notification (`Notification.js`)

**Document count in DB:** 829 (sampled 200)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `body` | String | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `dedupe_key` | String | USED | Prevents duplicate sends in multi-instance deployments. Referenced in student-notifications.service.js, instructor-notifications.service.js, timetable-class-reminder.scheduler.js |
| `deep_link` | String | USED | Referenced in admin-catalog.controller.js, student-notifications.service.js, timetable-class-reminder.scheduler.js |
| `read_at` | Date, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-catalog.controller.js |
| `ref_id` | String | USED | Referenced in seed.js, notifications.controller.js, admin-catalog.controller.js |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |
| `type` | String, enum, indexed | USED | announcement \| system \| class_start_10m \| recording_uploaded \| notes_uploaded — Generic name — usage matches likely cover this field |
| `email_sent_at` | Date | LOW-USAGE | Only 2 ref(s) in: student-notifications.service.js |
| `email_to` | String | LOW-USAGE | Email delivery audit. Only 1 ref(s) in: student-notifications.service.js |

**Indexes:** uniq sparse { dedupe_key }

### OtpRequest (`OtpRequest.js`)

**Document count in DB:** 35 (sampled 35)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `email` | String, required, lowercase, indexed | USED | Generic name — usage matches likely cover this field |
| `expires_at` | Date, required, indexed | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |
| `otp` | String, required | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |
| `otp_request_id` | String, required, unique, indexed | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |
| `used_at` | Date | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |

### PersonalDoubt (`PersonalDoubt.js`)

**Document count in DB:** 3 (sampled 3)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `answered_at` | Date | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |
| `code` | String | USED | Generic name — usage matches likely cover this field |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `image_url` | String | USED | Referenced in seed.js, staff-doubts.controller.js, admin-catalog.controller.js |
| `status` | String, enum, indexed | USED | pending \| answered — Generic name — usage matches likely cover this field |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `subject` | String, required | USED | Generic name — usage matches likely cover this field |
| `teacher_name` | String | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |
| `teacher_reply` | String | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |
| `teacher_reply_code` | String | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |
| `teacher_reply_image_url` | String | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |
| `unread_by_student` | Boolean | USED | Referenced in staff-doubts.controller.js, doubts.controller.js |

### ReferralEvent (`ReferralEvent.js`)

**Document count in DB:** 0 (no documents — orphan rows skipped)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `event` | String, required | USED | Referenced in admin-catalog.controller.js, timetable.controller.js, staff-panel-notifications.controller.js |
| `meta` | Mixed | USED | Referenced in response.js, admin.controller.js, referral.controller.js |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |

### ScorecardEntry (`ScorecardEntry.js`)

**Document count in DB:** 1 (sampled 1)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `assessment_period` | String, required | USED | Calendar month YYYY-MM. Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `batch_id` | String, required, lowercase, indexed | USED | Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `batch_recommendation` | String | USED | Referenced in admin-scorecard.controller.js |
| `exam_date` | Date | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `exam_type` | String | USED | Denormalized from test. Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `marks_obtained` | Number, required, min 0 | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `notes` | String | USED | Generic name — usage matches likely cover this field |
| `performance_status` | String | USED | Referenced in admin-scorecard.controller.js |
| `scholarship_amount` | Number, min 0 | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `scholarship_percent` | Number, 0-100 | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `task_label` | String, required | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `test_id` | ObjectId(ScorecardTest), indexed | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `total_marks` | Number, required, min 0 | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `updated_by_staff_id` | ObjectId(Staff) | USED | Referenced in admin-scorecard.controller.js |
| `next_month_fee` | (in DB only) | ORPHAN | Appears in 1/1 sampled docs; not declared in current schema |

**Indexes:** uniq { student_id, assessment_period, task_label }

### ScorecardTest (`ScorecardTest.js`)

**Document count in DB:** 1 (sampled 1)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `batch_allocation_rules` | String | USED | Referenced in admin-scorecard.controller.js |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `exam_date` | Date, required | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `is_active` | Boolean | USED | Referenced in create-super-admin.js, admin-scorecard.controller.js, admin-catalog.controller.js |
| `name` | String, required | USED | Generic name — usage matches likely cover this field |
| `scholarship_rules` | String | USED | Referenced in admin-scorecard.controller.js |
| `test_type` | String, required, enum, lowercase | USED | scholarship_test \| performance_test \| monthly_test \| cst \| mock_test \| random_test \| custom_test. Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `total_marks` | Number, required, min 0 | USED | Referenced in admin-scorecard.controller.js, student-scorecard.controller.js |
| `updated_by_staff_id` | ObjectId(Staff) | USED | Referenced in admin-scorecard.controller.js |

**Indexes:** { test_type, is_active }; text { name, description }

### Staff (`Staff.js`)

**Document count in DB:** 12 (sampled 12)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `account_status` | String, enum | USED | active \| inactive \| suspended. Referenced in staff-management.controller.js |
| `admin_notes` | String | USED | Referenced in staff-management.controller.js |
| `assigned_students` | [String] | USED | Referenced in staff-management.controller.js |
| `availability` | String | USED | Generic name — usage matches likely cover this field |
| `batches_assigned` | [String] | USED | Referenced in instructorBatchScope.js, backfill-instructor-batches-all-catalog.js, staff-management.controller.js |
| `bio` | String | USED | Generic name — usage matches likely cover this field |
| `email` | String, required, unique, lowercase | USED | Generic name — usage matches likely cover this field |
| `experience_level` | String | USED | Referenced in staff-management.controller.js |
| `experience_years` | Number, 0-60 | USED | Referenced in staff-management.controller.js |
| `expertise_area` | String | USED | Referenced in staff-management.controller.js |
| `is_active` | Boolean | USED | Referenced in create-super-admin.js, admin-scorecard.controller.js, admin-catalog.controller.js |
| `is_profile_complete` | Boolean | USED | Referenced in staff-management.controller.js |
| `last_login_at` | Date | USED | Referenced in requestMeta.js, staff-management.controller.js, admin.controller.js |
| `last_login_ip` | String | USED | Referenced in requestMeta.js, staff-management.controller.js, admin.controller.js |
| `last_login_user_agent` | String | USED | Referenced in requestMeta.js, staff-management.controller.js, admin.controller.js |
| `last_updated_by_admin` | ObjectId(Staff) | USED | Referenced in staff-management.controller.js |
| `name` | String, required | USED | Generic name — usage matches likely cover this field |
| `password_hash` | String | USED | Optional bcrypt hash. Referenced in create-super-admin.js, staff-management.controller.js, staff-auth.controller.js |
| `password_set_by_user` | Boolean | USED | Referenced in create-super-admin.js, staff-management.controller.js, staff-auth.controller.js |
| `phone_number` | String | USED | Generic name — usage matches likely cover this field |
| `profile_completion_score` | Number, 0-100 | USED | Referenced in staff-management.controller.js |
| `profile_image_url` | String | USED | Referenced in migrate-staff-static-media.js, staff-doubts.controller.js, staff-management.controller.js |
| `resume_url` | String | USED | Referenced in migrate-staff-static-media.js, staff-management.controller.js |
| `role` | String, enum, required | USED | super_admin \| admin \| instructor \| mentor — Generic name — usage matches likely cover this field |
| `subjects_teaching` | [String] | USED | Referenced in staff-management.controller.js |

### StaffOtpRequest (`StaffOtpRequest.js`)

**Document count in DB:** 51 (sampled 51)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `email` | String, required, lowercase, indexed | USED | Generic name — usage matches likely cover this field |
| `expires_at` | Date, required, indexed | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |
| `otp` | String, required | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |
| `otp_request_id` | String, required, unique, indexed | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |
| `used_at` | Date | USED | Referenced in staff-auth.controller.js, student.controller.js, auth.controller.js |

### StaffPanelNotification (`StaffPanelNotification.js`)

**Document count in DB:** 78 (sampled 78)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `audience` | String, enum, required, indexed | USED | global \| role \| individual. Referenced in staff-management.controller.js, support.controller.js, auth.controller.js |
| `category` | String, enum, indexed | USED | updates \| alerts \| assignments \| system — Generic name — usage matches likely cover this field |
| `created_by` | ObjectId(Staff) | USED | Referenced in admin-todo.controller.js, staff-management.controller.js, staff-panel-notifications.controller.js |
| `dedupe_key` | String | USED | Referenced in student-notifications.service.js, instructor-notifications.service.js, timetable-class-reminder.scheduler.js |
| `event_type` | String | USED | Referenced in admin-catalog.controller.js, staff-management.controller.js, support.controller.js |
| `message` | String, required | USED | Generic name — usage matches likely cover this field |
| `recipient_id` | ObjectId(Staff), indexed | USED | Referenced in staff-management.controller.js, staff-panel-notifications.controller.js, mentor-reminder.scheduler.js |
| `source` | String, enum, indexed | USED | manual \| event — Generic name — usage matches likely cover this field |
| `target_roles` | [String] | USED | Referenced in staff-management.controller.js, support.controller.js, staff-panel-notifications.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |

**Indexes:** { createdAt }; { audience, createdAt }; uniq sparse { dedupe_key }

### StaffPanelNotificationState (`StaffPanelNotificationState.js`)

**Document count in DB:** 12 (sampled 12)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `dismissed_at` | Date | USED | Referenced in staffPanelNotification.service.js |
| `notification_id` | ObjectId(StaffPanelNotification), required, indexed | USED | Referenced in staff-panel-notifications.controller.js, staffPanelNotification.service.js |
| `read_at` | Date | USED | Referenced in seed.js, notifications.controller.js, admin-catalog.controller.js |
| `staff_id` | ObjectId(Staff), required, indexed | USED | Referenced in staff-doubts.controller.js, doubts.controller.js, instructor-notifications.service.js |

**Indexes:** uniq { notification_id, staff_id }

### Student (`Student.js`)

**Document count in DB:** 16 (sampled 16)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `avatar_url` | String | USED | Referenced in student-achievement.controller.js, leaderboard.controller.js, staff-doubts.controller.js |
| `batch` | String | USED | Display label. Referenced in achievement-badges.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `batch_allowance` | String | USED | Referenced in seed.js, student.controller.js, auth.controller.js |
| `batch_id` | String | USED | Identifier. Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `course` | String | USED | Generic name — usage matches likely cover this field |
| `cst_registration_id` | String, sparse indexed | USED | Referenced in admin-scorecard.controller.js, student.controller.js, student-scorecard.controller.js |
| `email` | String, required, unique, lowercase | USED | Generic name — usage matches likely cover this field |
| `enrollment_batch_name` | String | USED | Referenced in enrollment.js, seed.js, leaderboard.controller.js |
| `enrollment_batch_prefix` | String | USED | Referenced in enrollment.js, seed.js, notes.controller.js |
| `enrollment_date` | Date | USED | Referenced in student.controller.js, auth.controller.js, admin.controller.js |
| `enrollment_number` | String, sparse unique | USED | Referenced in enrollment.js, seed.js, admin-scorecard.controller.js |
| `enrollment_roll_no` | String | USED | Referenced in enrollment.js, seed.js, student.controller.js |
| `enrollment_section` | String | USED | Referenced in batchDefaults.js, enrollment.js, seed.js |
| `enrollment_year` | Number | USED | Referenced in enrollment.js, seed.js, student.controller.js |
| `last_login_at` | Date | USED | Referenced in requestMeta.js, staff-management.controller.js, admin.controller.js |
| `last_login_ip` | String | USED | Referenced in requestMeta.js, staff-management.controller.js, admin.controller.js |
| `last_login_user_agent` | String | USED | Referenced in requestMeta.js, staff-management.controller.js, admin.controller.js |
| `name` | String, required | USED | Generic name — usage matches likely cover this field |
| `parent_name` | String | USED | Referenced in seed.js, student.controller.js, auth.controller.js |
| `password_hash` | String | USED | Referenced in create-super-admin.js, staff-management.controller.js, staff-auth.controller.js |
| `password_set_by_user` | Boolean | USED | Referenced in create-super-admin.js, staff-management.controller.js, staff-auth.controller.js |
| `phone_number` | String | USED | Parent / guardian contact — Generic name — usage matches likely cover this field |
| `progress` | Number | USED | Generic name — usage matches likely cover this field |
| `referral_benefits_queue` | [subdoc] | USED | Pending refer & earn rewards. Referenced in admin.controller.js, referral.controller.js |
| `referral_bonus_count` | Number, 0-500 | USED | Manual / offline referral count. Referenced in admin.controller.js, referral.controller.js |
| `referral_code` | String, sparse indexed | USED | Referenced in admin.controller.js, referral.controller.js |
| `referred_by` | ObjectId(Student) | USED | Referenced in admin.controller.js, referral.controller.js |
| `registration_fee_discount_percent` | Number, 0-100 | USED | Referenced in admin.controller.js, referral.controller.js |
| `role` | String, enum | USED | student \| mentor \| teacher \| admin — Generic name — usage matches likely cover this field |
| `school_class` | Number | USED | Grades 5–10. Referenced in student.controller.js, auth.controller.js, admin.controller.js |
| `school_name` | String | USED | Referenced in student.controller.js, auth.controller.js, admin.controller.js |
| `section_id` | String | USED | Catalog section id. Referenced in enrollment.js, seed.js, announcement.controller.js |
| `student_phone` | String | USED | Referenced in student.controller.js, admin-support.controller.js, auth.controller.js |
| `whatsapp_number` | String | USED | Referenced in student.controller.js, admin-support.controller.js, auth.controller.js |

**Indexes:** uniq sparse { enrollment_number }; sparse { cst_registration_id }; sparse { referral_code }

### StudentAchievementBadge (`StudentAchievementBadge.js`)

**Document count in DB:** 12 (sampled 12)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `accent` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `award_period` | String | USED | IST month YYYY-MM for recurring program badges. Referenced in student-achievement.controller.js, badge-program.service.js |
| `awarded_at` | Date | USED | Referenced in student-achievement.controller.js, admin-student-achievement.controller.js, badge-program.service.js |
| `badge_code` | String, required | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `badge_layout` | Mixed | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, badge-program.service.js |
| `category` | String, enum, required | USED | arena_quests \| arena_streak \| program — Generic name — usage matches likely cover this field |
| `custom_image_url` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, badge-program.service.js |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `icon_key` | String | USED | Referenced in student-achievement.controller.js, admin-badge-program.controller.js, admin-badge-definition.controller.js |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |
| `threshold_value` | Number, required, min 0 | USED | Referenced in student-achievement.controller.js, admin-student-achievement.controller.js, badge-program.service.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |

**Indexes:** uniq { student_id, badge_code, award_period }

### StudentBroadcastLog (`StudentBroadcastLog.js`)

**Document count in DB:** 0 (no documents — orphan rows skipped)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `created_by` | ObjectId(Staff) | USED | Referenced in admin-todo.controller.js, staff-management.controller.js, staff-panel-notifications.controller.js |
| `message` | String, required | USED | Generic name — usage matches likely cover this field |
| `recipient_count` | Number, required, min 0 | USED | Referenced in staff-panel-notifications.controller.js |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |

**Indexes:** { createdAt }

### SupportConversation (`SupportConversation.js`)

**Document count in DB:** 6 (sampled 6)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `admin_status` | String, enum | USED | pending \| ongoing \| resolved. Referenced in support.controller.js, admin-support.controller.js |
| `admin_status_updated_at` | Date | USED | Referenced in support.controller.js, admin-support.controller.js |
| `last_message_at` | Date | USED | Referenced in support.controller.js, admin-support.controller.js |
| `status` | String, enum | USED | open \| closed — Generic name — usage matches likely cover this field |
| `student_id` | ObjectId(Student), required, indexed | USED | Referenced in seed.js, notifications.controller.js, admin-scorecard.controller.js |

**Indexes:** { student_id, status }

### SupportMessage (`SupportMessage.js`)

**Document count in DB:** 6 (sampled 6)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `admin_status` | String, enum | USED | Referenced in support.controller.js, admin-support.controller.js |
| `admin_status_updated_at` | Date | USED | Referenced in support.controller.js, admin-support.controller.js |
| `conversation_id` | ObjectId(SupportConversation), required, indexed | USED | Referenced in support.controller.js, admin-support.controller.js |
| `from` | String, enum, required | USED | student \| agent — Generic name — usage matches likely cover this field |
| `media` | subdoc {url,mime_type,file_name,bytes,kind} | USED | Generic name — usage matches likely cover this field |
| `text` | String, required | USED | Generic name — usage matches likely cover this field |

### TimetableEvent (`TimetableEvent.js`)

**Document count in DB:** 3 (sampled 3)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `batch_id` | String, indexed | USED | Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `date` | Date, required, indexed | USED | Generic name — usage matches likely cover this field |
| `description` | String | USED | Generic name — usage matches likely cover this field |
| `title` | String, required | USED | Generic name — usage matches likely cover this field |
| `type` | String, enum, required, indexed | USED | holiday \| workshop \| mentor \| event — Generic name — usage matches likely cover this field |

### TimetableSlot (`TimetableSlot.js`)

**Document count in DB:** 17 (sampled 17)

| Field | Type | Status | Notes |
|---|---|---|---|
| `_id` | ObjectId | META |  |
| `createdAt` | Date | META | Mongoose timestamp |
| `updatedAt` | Date | META | Mongoose timestamp |
| `batch_id` | String, required, indexed | USED | Referenced in batchDefaults.js, assignmentBatchFilter.js, instructorBatchScope.js |
| `class_date` | String YYYY-MM-DD, required, indexed | USED | Referenced in admin-catalog.controller.js, timetable.controller.js, student-notifications.service.js |
| `day` | String, enum, required, indexed | USED | Monday..Sunday — Generic name — usage matches likely cover this field |
| `instructor_reminder_10m_sent_at` | Date | USED | Referenced in admin-catalog.controller.js, timetable-class-reminder.scheduler.js |
| `is_taken` | Boolean, indexed | USED | Referenced in admin-catalog.controller.js |
| `meet_link` | String | USED | Referenced in seed.js, admin-catalog.controller.js, mentor-sessions.controller.js |
| `meet_link_missing_10m_alert_sent_at` | Date | USED | Referenced in admin-catalog.controller.js, timetable-class-reminder.scheduler.js |
| `notes_link` | String | USED | Referenced in admin-catalog.controller.js, timetable.controller.js, student-notifications.service.js |
| `recording_link` | String | USED | Referenced in seed.js, admin-catalog.controller.js, timetable.controller.js |
| `section_id` | String, indexed | USED | Referenced in enrollment.js, seed.js, announcement.controller.js |
| `student_reminder_10m_sent_at` | Date | USED | Referenced in admin-catalog.controller.js, timetable-class-reminder.scheduler.js |
| `subject` | String, required, indexed | USED | Generic name — usage matches likely cover this field |
| `teacher` | String, required | USED | Generic name — usage matches likely cover this field |
| `time` | String, required | USED | Generic name — usage matches likely cover this field |
| `topic` | String | USED | Generic name — usage matches likely cover this field |
