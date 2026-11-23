# Schema redesign proposal (schools, cohorts, roles)

Status: **proposal, nothing implemented.** Written 2026-11-23 from a read of all 44 models plus a read-only look at the production database (counts only), then revised after an independent code review (section 8). Decisions are the principal engineer's; section 7 needs the owner.

## 1. Why now

Production is small: 13 students, 5 batches with 5 courses (one to one), 27 enrollments, 55 invoices. A change of shape costs little today and gets more expensive with every student, school and content row. Schools add a tenant dimension to almost every query, so the foundations come first.

Problems this fixes, each verified in code (current behaviour: [batches-and-enrollment.md](batches-and-enrollment.md)):

1. **Two sources of membership.** `Student.batch_id/section_id/enrollment_*` and `StudentEnrollment.batch_id/section_id`; `enrollment_number` is parsed to derive them.
2. **Batch and section are free-form strings** with ad hoc normalisation (three copies of `normSectionId`, `$toLower` in queries defeating indexes).
3. **Five targeting shapes, eight copies of "can this student see it".** Only mentor slots and project assignments honour the per-batch section; the timetable and doubts use the primary batch/section only.
4. **Roles are a string in the JWT; staff scope is `[String]`.** It cannot say "teacher at school X, batch Y only"; scoping is hand-written per controller (contests, scorecard tests and the instructor directory are unscoped); a role change is not effective until the token expires.
5. **Student is overloaded** and **Course is welded to Batch** (`Course.linked_batch_id`), so billing and content are keyed differently.
6. **Names copied as strings** (`teacher`, `mentor_name`, `author_name`, `created_by_name`).
7. **Orphans and double billing.** Deleting a student leaves enrollments behind (8 today); nothing enforces one invoice per enrollment and month.

## 2. Principles

- Every reference is an `ObjectId`. Human codes (`program.code`, `school.code`) are display and import keys, never foreign keys.
- One concept, one place: membership only in `Enrollment`, scope only in `StaffAssignment`.
- One audience shape for targeted content and one module that answers "can this student see it".
- Explicit over implicit. "Everyone" is a flag, never an empty array.
- Soft delete for people and structure; nothing in the migration deletes data.
- Schools are a dimension in one database, not separate databases.
- Build only what is needed: no school contracts or billing-to-school, no `Subject`/`EnrollmentEvent`/`Counter`/`MentorMentee` collections, no separate `Section` collection.

## 3. Target model

### 3.1 Structure

| Model | Purpose | Key fields |
|---|---|---|
| `School` | Partner or source school. CodeMasti's own direct students belong to the built-in school `codemasti`, so `school_id` is never null. | `code` (unique), `name`, `kind` (`direct`/`partner`/`other`), `status`, `contact`, `city` |
| `Program` | The curriculum (Spark, Builders, Innovators, Summer Adventure, Builder Ninja). Replaces `BatchCatalog`. | `code`, `name`, `tier_label`, `is_active`, `recording_drive_folder_url` |
| `Cohort` | One run of a program for one school and term. All targeting, leaderboards and doubt channels hang off the cohort. | `program_id`, `school_id`, `course_id`, `term` (`2026-27`), `name`, `starts_on`, `ends_on`, `status`, `sections[]` (embedded `{_id, code, name}`) |
| `Course` | **Kept, as the fee plan only.** Loses `linked_batch_id`. | `code`, `name`, `base_fee_paise`, `billing_mode`, `is_active` |

`program_id` and `school_id` of a cohort never change after creation (enforced), so other collections can copy them safely. Sections are embedded in the cohort with their own `_id`, so references are stable without a collection (sections are barely used today: 1 of 23 active enrollments has one).

### 3.2 People

| Model | Purpose | Key fields |
|---|---|---|
| `Student` | Identity, guardian, school. | `name`, `email` (unique), `phone`, `whatsapp`, `school_id`, `grade`, `guardian` {`name`, `phone`}, `student_code` (unique, stored, never parsed), `external_ids.cst_registration_id`, `avatar_url`, auth fields, referral and fee-discount state (unchanged for now), `deleted_at` |
| `Enrollment` | The only membership record. | `student_id`, `cohort_id`, `section_id?`, `school_id`, `program_id` (copied, immutable), `status` (`active`/`completed`/`withdrawn`), `is_primary`, `roll_no`, `started_on`, `ended_on`, `fee_override_paise?`, `source`, `history[]` (embedded, append-only: type, by, at) |
| `Staff` | Identity only. | `name`, `email`, `phone`, `status` (one enum, replacing `is_active` + `account_status`), `token_version`, auth fields |
| `StaffAssignment` | Role and scope; a person can hold several. | `staff_id`, `role`, `school_id?`, `cohort_id?`, `section_id?`, `student_ids[]` (mentor mentees), `subjects[]` (strings, as today), `active` |

Rules:
- **`student_code`** keeps today's values (`I260105`) and is generated for new students with a unique index and retry (as roll numbers are today). Nothing derives batch, section or roll from it.
- **Primary cohort.** `Enrollment.is_primary` marks the one enrollment per student that receives the referral and registration credits and drives the default view. A partial unique index `{student_id}` where `is_primary: true, status: "active"` enforces at most one. This replaces `Student.batch_id` in `invoice-generator.service.js` (`isPrimaryBatchInvoice`).
- **Removed from `Student`:** `batch`, `batch_id`, `section_id`, `course`, `progress`, `batch_allowance`, all `enrollment_*` fields, `school_name`, `school_class` (now `school_id`, `grade`). `Student.role` stops being written with `mentor/teacher/admin` values; student tokens keep a constant `role: "student"` (`auth.controller.js` puts it in the token).
- **Soft delete.** Deleting a student ends their active enrollments and cancels pending invoices in one transaction; nothing is orphaned.
- **Roll numbers.** `roll_no` is `<prefix><YY><4 digits>` per cohort via a unique index `{cohort_id, roll_no}` with retry, as today; the prefix comes from the program.

### 3.3 Roles and scope

Roles stay `super_admin`, `admin`, `instructor`, `mentor`, plus **`school_admin`** (manages people and reports of their own school; no billing, no other schools). Adding it needs edits in `models/Staff.js`, `utils/rbac.js`, `controllers/staff-auth.controller.js` and the admin UI (redirect, badge, `ROLES`).

A `null` assignment field means "all at that level".

| Example | `role` | `school_id` | `cohort_id` | `section_id` |
|---|---|---|---|---|
| Platform owner / admin | `super_admin`, `admin` | null | null | null |
| Instructor, Spark at school X, section A | `instructor` | X | spark-X-2026 | A |
| Mentor with named mentees | `mentor` | codemasti | null | null (+ `student_ids`) |
| School coordinator | `school_admin` | X | null | null |

Mechanics:
- Permissions are named strings in one table in code (`assignments:write`, `students:read`, `billing:manage`). `requirePermission(name)` plus shared scope helpers replace the ~40 role arrays and the hand-written branches (`getInstructorAssignedBatchIds` has about 45 call sites, all mapped before this phase starts).
- **No extra query:** `requireStaffAuth` already does `Staff.findById`; it also loads the active assignments and sets `req.scope = { schoolIds, cohortIds, sectionIds, studentIds }`. Because scope and role come from the database on every request, a change takes effect immediately and **`token_version` is not bumped** (it would log the person out). The JWT role stays as a coarse hint only.
- Admin UI: `ProtectedRoute`, nav and `StaffPage` move from `staff.role` checks and `batches_assigned` CSV editing to the permission list and an assignment editor. About 20 pages that send `batch_id` change once, in the cohort phase.

### 3.4 Targeted content (one shape)

Assignment, Contest, Note, Announcement, TimetableSlot, TimetableEvent, MentorSlot and ArenaQuestion embed:

```
audience: {
  everyone:    Boolean,                       // every student of the platform
  school_ids:  [ObjectId],                    // every student of these schools
  program_ids: [ObjectId],                    // every cohort of these programs, including cohorts created later
  targets:     [{ cohort_id, section_ids[] }],// per-cohort narrowing; empty section_ids = whole cohort
  student_ids: [ObjectId]                     // individual students (mentor slots)
}
owner_school_id: ObjectId?                    // who created it; null = CodeMasti-wide
```

`utils/audience.js` owns both directions: `studentCanSee(audience, enrollments)` and `audienceQueryForStudent(enrollments)`. The eight filters are deleted and the per-batch section works everywhere, including the timetable and doubts.

Mapping from today:
- `Note.target_section_refs` becomes `targets` pairs; multi-batch `Assignment` rows keep one row per cohort with one target, so `creation_group_id` and the project-creation unique index still apply.
- Empty batch ("everyone": timetable events, assignments, arena questions, untagged XP content) migrates to `everyone: true`. The XP and leaderboard code that treats untagged content as global is rewritten against that flag.
- `Announcement.batch` (display name) is dropped; `scope: "global"` becomes `everyone: true`.
- `ScorecardTest` is not targeted (it has no batch fields); `Contest` is, one row per cohort with a shared `test_id`.

### 3.5 Keys that are batch ids today

| Collection | Change |
|---|---|
| `ScorecardEntry.batch_id` (read by invoicing for scholarships) | `cohort_id`; fix the unique index `{student_id, assessment_period, task_label}` to include it, so multi-cohort students stop colliding |
| `MonthlyLeaderboardBadge.scope_key` (read by invoicing for Student of the Month; `solo:<id>` form) | cohort id string or `solo:<id>`; existing rows rewritten |
| `StudentLeaderboardGapState.batch_id`, XP aggregation, achievement services | cohort id |
| `CommunityMessage.channel_id` (today `Student.batch_id`) | cohort id; the doubts controller reads the student's enrollments instead of the removed field |
| `Staff.batches_assigned`, `assigned_students` | `StaffAssignment` |

### 3.6 Billing

- Invoices stay keyed by `enrollment_id`, `course_id` (fee plan) and `student_id`; the admin invoice API and student payments keep working. Add `cohort_id` and `period_key`.
- **`period_key`** (`2026-11`) is backfilled from `period_start` before the index exists. Upfront and manual one-off invoices use `upfront` and `one-off:<invoice_number>`.
- **Unique index** on `{enrollment_id, period_key}` as a partial index with `status: { $in: ["pending","paid","failed","refunded","partially_refunded"] }` (partial filters cannot use `$ne`), so a cancelled invoice never blocks a new one and double billing is rejected by the database.
- Billing a school as a customer is **not built** (`Payment` and `Invoice` require `student_id`). It is a separate project if ever needed.
- Referral and registration credits stay on `Student` for now; moving them touches `admin.controller`, `referral.controller` and `invoice-discount.service` and brings no benefit for schools.

## 4. What stays as it is

OTP and password auth, JWT lifetimes, response envelope, PhonePe and manual UPI flows, code runners, AI evaluator, Cloudinary, notifications. Only their foreign keys change.

## 5. Migration plan (expand, migrate, contract)

Each phase ships on its own and leaves the app working. Every script is dry-run by default, writes a JSON backup first and **never deletes** (soft states only). Old collections stay untouched until the last phase, so rollback is a code revert.

| Phase | Work | Done when |
|---|---|---|
| 0 | Clean the data softly: run the duplicate-invoice cancel, mark the 8 orphan enrollments `completed` with a note, reject the stale payment proof. | Reconciliation and counts are clean. |
| 1 | Add `School`, `Program`, `Cohort` (+ embedded sections). Seed the `codemasti` school, 5 programs and 5 cohorts from the current batches and courses; point each course at its cohort; map each student's `school_name` to a `School` row. | Reference data exists; nothing reads it yet. |
| 1.5 | **Tests first**: a small harness (Docker MongoDB replica set) around enrollment services, the invoice generator and the audience module. | Green in CI before phase 2. |
| 2a | New `Enrollment` built from `StudentEnrollment` + `Student` batch fields, **dual-written** while old code still reads the old collection; then switch membership reads. Set `is_primary`. | One membership source; per-cohort sections honoured. |
| 2b | `audience.js`; migrate each targeted collection's batch/section strings to `audience`; delete the eight filters. | One resolver used everywhere. |
| 2c | Rewrite leaderboard, badge, XP, gap-state, scorecard-entry and community channel keys to cohort ids. | Invoicing discounts and leaderboards read cohort ids. |
| 3 | `StaffAssignment`, `requirePermission`, scope helpers, admin UI permission list; map and replace every `getInstructorAssignedBatchIds` caller. | No controller branches on role strings. |
| 4 | Billing: `cohort_id`, `period_key` backfill, partial unique index. | Double billing is rejected by the database. |
| 5 | Contract: drop legacy fields and the old `BatchCatalog`/`StudentEnrollment` collections only after a verified soak and a backup. | Code and DB carry one shape. |

API compatibility: the apps send `?batch_id=`; the server maps it to a cohort id during the transition, so the frontends change once, in 2a.

## 6. Cost and risk

- Phases 2 to 4 touch most controllers; the repo has no tests today, hence phase 1.5.
- Transactions need a replica set. Production has one; local Docker was unavailable earlier, so the new double-billing guard has been tested only with stubs.
- The admin invoice bulk endpoint is keyed by `course_id`; keeping `Course` as the fee plan avoids breaking it.

## 7. Open questions (owner decision)

1. **School meaning.** Treated here as a tenant that groups students and staff (partner schools) and as a lookup for non-partner schools (`kind: other`). If schools will be billed as customers, that needs its own design.
2. **Student login for school students.** Login is email OTP only. If school students have no personal email, add phone OTP or school-issued emails before the first school is onboarded.
3. **What `school_admin` may do.** Assumed: create and edit students and enrollments of their own school, view reports, no billing.
4. **Terms.** A student continuing next year gets a new enrollment in a new cohort (new `term`) rather than reusing the old row.

## 8. Review outcome

An independent reviewer checked the first draft against the code and approved it with changes. Applied here: added the missing batch-keyed collections (3.5); extended the audience with `student_ids`, per-cohort section pairs and `program_ids`; defined the primary-cohort rule; made the partial index `$in`-based with a `period_key` backfill; dropped `bill_to: school`; kept `Course` as the fee plan; deferred `Subject`, `EnrollmentEvent`, `MentorMentee`, `Counter` and a `Section` collection; stopped bumping `token_version` on scope changes; split phase 2; moved tests ahead of it; and removed deletion from phase 0.
