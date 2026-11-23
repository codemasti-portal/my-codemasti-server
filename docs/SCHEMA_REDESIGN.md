# Schema redesign proposal (v4.1: one seat = one course experience)

Status: **proposal, nothing implemented.** Written 2026-11-23. v1 copied today's app shape. v2 and v3 were drawn from the student lifecycle and reviewed from finance, school-partner/privacy and engineering views. v4 applies three owner rules and adds how staff are created and assigned.

## 0. The owner's rules

1. **A known student is never registered or enrolled again.** One profile, one permanent code, for life.
2. **A student can be in several courses at once**, and can move to a new or upgraded course.
3. **Everything a student earns stays with that course.** XP, assignments, scores and badges belong to the course they were earned in and never flow into the next one. A new course starts fresh.

Rule 3 reverses v3's "facts belong to the student". The new principle is below.

## 1. Core idea

> **The student is a permanent identity. A *seat* is that student's whole experience of one course.**

- `Student` holds who they are: name, contact, guardian, school, login. It never changes when they move courses.
- `Enrollment` (the seat, an evolved `StudentEnrollment`) holds one student's run through one cohort. Every learning record is owned by the seat through `enrollment_id`.
- A finished seat becomes a read-only **transcript**. A new seat starts with zero XP, no submissions and an empty leaderboard position.
- Moving up is "close this seat, open the next one", one action, no re-registration.

| Situation | What happens |
|---|---|
| Known student wants a second course | Staff search, pick the existing profile, "add a seat"; the new seat is fresh, the old one is untouched |
| Student finishes Spark and moves to Builders | **Promote**: Spark seat completed with a frozen result summary; Builders seat opened empty; nothing is copied except identity, the primary flag and discounts that belong to the person |
| Student returns after a break | A new seat on the same profile; the old transcript stays as it was |
| Student pauses | Seat `paused`: read-only, no invoices; resume later |
| Studying month after month | Nothing to do; seats are open-ended |

Duplicates are blocked in the database: **email is a hard unique key**; a matching phone only warns (siblings share a guardian phone); a server-side search runs before any create.

## 2. Principles

- People are permanent; seats are per course; learning records belong to the seat.
- Identity never encodes where someone studies (today `I260105` encodes the batch).
- Evolve, do not replace: `StudentEnrollment` keeps its `_id`s because invoices point at them.
- One concept, one place: seats only in `StudentEnrollment`; where staff work only in `StaffAssignment`; who a mentor looks after only in `MentorLink`; targeting only in one audience shape.
- Open-ended by default; dates are optional facts.
- Explicit over implicit: "everyone" is a flag, an empty list means nothing.
- Soft states; nothing in the migration deletes data; archived rows hidden by one shared scope.
- Build the seam, not the feature (guardian login, payers, leads, certificates, school contracts are deferred).

## 3. Model

### 3.1 Identity

| Model | Key fields |
|---|---|
| `Student` | `student_code` (unique, stored, never parsed), `name`, `email` (unique, normalised), `phone`, `whatsapp`, `home_school_id`, `guardian` {`name`, `phone`, `email?`} (embedded, staff-only), `consent` {`purpose`, `version`, `given_by`, `at`}, `external_ids.cst_registration_id`, `avatar_url`, auth fields, `registration_discount_percent`, `referral_benefits_queue` (person-level, unchanged), `archived_at` |
| `Staff` | `name`, `email`, `phone`, `status` (one enum, replaces `is_active` + `account_status`), `created_by`, `invited_at`, `token_version`, auth fields |
| `School` | `code` (unique), `name`, `kind` (`direct`/`partner`/`other`), `status`, `city`, `settings` {`branding`, `seat_cap`, `contract_from`, `contract_to`}. Direct students use the built-in `codemasti` school. |

Removed from `Student`: `batch`, `batch_id`, `section_id`, `course`, `progress`, `batch_allowance`, every `enrollment_*` field, `school_name`/`school_class` (→ `home_school_id`, `grade` on the seat). `Student.batch_id` is dual-written until the last phase because referral logic still reads it.

### 3.2 Catalog and delivery

| Model | Key fields |
|---|---|
| `Program` (replaces `BatchCatalog`) | `code`, `name`, `kind` (`pathway`/`workshop`/`bootcamp`/`event`), `level`, `next_program_id?` (suggests a promote target only), `is_active`, `recording_drive_folder_url` |
| `FeePlan` (today's `Course`, kept; loses `linked_batch_id`) | `code`, `name`, `base_fee_paise`, `billing_mode`, `is_active` |
| `Cohort` | `program_id`, `host_school_id`, `fee_plan_id`, `name`, `academic_year?`, `starts_on?`, `ends_on?`, `status`, `sections[]` (embedded `{_id, code, name}`) |

`program_id` and `host_school_id` of a cohort never change. `host_school_id` (who delivers it) drives staff visibility; `Student.home_school_id` is information only. Cohorts and programs are read directly or with a short TTL, not from the per-process 60-second registry.

### 3.3 The seat: `StudentEnrollment`, evolved in place

Added: `cohort_id`, `program_id`, `host_school_id` (copied, immutable), `section_id?`, `grade`, `is_primary`, `billing_from`, `end_reason` (`promoted`/`graduated`/`left`/`transferred`), `outcome` (frozen summary written on completion: total XP, badge count, assignments done, average score, final rank), `mentor_id?` (current mentor, a convenience copy of the active `MentorLink`). `status` becomes `active`/`paused`/`completed`/`withdrawn` (legacy `cancelled` mapped to `withdrawn`).

Indexes (partial filters allow only equality, `$in`, `$type`, `$exists:true`, ranges; never `$ne`/`$nin`/`$or`): unique `{student_id, cohort_id}` where `status ∈ {active, paused}`; unique `{student_id}` where `is_primary: true` and `status ∈ {active, paused}`; unique `{cohort_id, roll_no}` where `roll_no` is a string (field omitted, not `""`); plus `{host_school_id, status}`, `{cohort_id, status, section_id}`, `{student_id, status}`.

Services (each one transaction, with an `AuditEvent` written inside it): `addSeat`, `promote(seat, targetCohort)` (complete old with `outcome`, open new fresh, set `is_primary` in an ordered write, reset `fee_override_paise`, end the old seat's mentor link, sync `Student.batch_id` until the last phase), `pause`, `resume`, `withdraw`, and `bulkPromote` (one transaction per student, with a report of skipped students).

### 3.4 Learning records belong to the seat

Every record below gets a required `enrollment_id` (and keeps `student_id`, plus `cohort_id` for scoping). Nothing is derived from `Student.batch_id` any more.

| Record | Owner key and indexes | Notes |
|---|---|---|
| `AssignmentSubmission`, `ArenaSubmission` | `enrollment_id`; attempt counts, first-attempt XP and accepted-streak are computed per seat | Ordinary submissions stay multi-attempt (no unique key); the project-type partial unique becomes `{assignment_id, enrollment_id}`; `ArenaSubmission` gets a `{enrollment_id, question_id}` index |
| `AssignmentXpGrant` | unique `{enrollment_id, assignment_id, question_id}` (was `{assignment_id, question_id, student_id}`) | XP is derived live from submissions per seat; the dead `Student.xp` write in `arena.controller.js` is removed |
| `StudentAchievementBadge` | unique `{enrollment_id, badge_code, award_period}` | Quest and milestone counts, "recovered" badges and the streak are per seat |
| `ScorecardEntry` | unique `{enrollment_id, assessment_period, task_label}` | Contest and test results already live here (via `test_id`); invoice scholarships read the seat's own entries |
| `StudentLeaderboardGapState` | unique `{enrollment_id}` (was one row per student) | derived state; reset on migration |
| `MonthlyLeaderboardBadge` | `cohort_id`; `scope_key` becomes the cohort id (`solo:<id>` stays) | Student-of-the-Month for invoicing reads the cohort key |
| `MentorSessionJoin`, `MentorSlot.booked_by` | unique `{slot_id, enrollment_id}`; `booked_by` holds the seat | |
| `PersonalDoubt` | new `enrollment_id` and `cohort_id` (it has no batch field today) | `doubts.controller` stops reading `Student.batch_id` |
| `CommunityMessage` | `cohort_id` channel; author's `enrollment_id` | |
| `Notification`, `ReferralEvent`, `OtpRequest`, support | `student_id` plus optional `cohort_id` tag | identity-level |
| `Invoice` | `enrollment_id` (already) | |

**Seat context on every request.** The `?batch_id=` query becomes an explicit `enrollment_id` on every student request that reads or earns; the server validates that the seat belongs to the caller. `utils/student-batch-context.js` (`scopeStudentToBatch`) becomes `resolveSeat(req, student)` and returns a seat, not a batch string. Content that targets everyone earns on the seat named in the request, which removes today's ambiguity for untagged content. **Active only earns:** `active` seats may submit, run, book and earn; `paused` and `completed` seats are read-only; the check lives in `assertStudentAssignmentAccess`, arena submit (which has no batch or seat check today) and mentor join.

**Student portal.** The course switcher is keyed on `enrollment_id` (it is keyed on `linked_batch_id` and hides paused or completed seats today), lists paused and completed seats as read-only transcripts, and profile, dashboard, achievements, streak, `/leaderboard/me` and the courses page show per-seat numbers. `Student.progress` and the lifetime totals go away.

### 3.5 Targeted content (one audience shape)

Assignment, Contest, Note, Announcement, TimetableSlot, TimetableEvent, MentorSlot and ArenaQuestion embed:

```
audience: { everyone, school_ids[], program_ids[], targets:[{cohort_id, section_ids[]}], student_ids[] }
audience_keys: [String]   // derived on save; the only thing queried
owner_school_id: ObjectId?
authored_by: ObjectId (staff)
```

`audience_keys` holds `all`, `school:<id>`, `program:<id>`, `cohort:<id>`, `section:<cohortId>:<sectionId>`, `student:<id>`. A student query is `{ audience_keys: { $in: seatKeys }, … }` with one multikey index per collection; `seatKeys` comes from the student's active seats (usually 1 to 3). `utils/audience.js` writes and reads both forms and replaces the eight hand-written filters (including the un-indexable `$toLower` filter in `utils/assignmentBatchFilter.js`). Mapping: empty batch → `everyone`; `Note.target_section_refs` → `targets`; project assignments keep one row per cohort so `creation_group_id` works; `ScorecardTest` is not targeted. Curriculum content targets `program_ids` once, so ten cohorts do not need ten copies.

## 4. How staff are created and assigned

Access is never a bare role. It is **a role plus an assignment**; a staff member with no active assignment can log in but sees nothing.

### 4.1 Models and what they replace

| Model | Key fields |
|---|---|
| `StaffAssignment` | `staff_id`, `role`, `school_id?`, `cohort_id?`, `section_id?`, `subjects[]`, `starts_on`, `ends_on?` (null = open; no separate `active` flag), `assigned_by`. Unique `{staff_id, role, school_id, cohort_id, section_id}` |
| `MentorLink` | `staff_id` (mentor), `enrollment_id`, `student_id`, `cohort_id`, `starts_on`, `ends_on?`, `assigned_by` |

A `null` scope field means "all at that level". Links go to seats, so a mentor follows a student's course, not the person across courses. A `program_id` scope is deferred.

| Today | Becomes |
|---|---|
| `Staff.batches_assigned` (string[], about 40 readers via `getInstructorAssignedBatchIds`, plus `staff-doubts`' own copy) | `StaffAssignment(role=instructor)` |
| `Staff.assigned_students` (free-text string[], read only by `staff-doubts`) | `MentorLink`; the free text cannot be mapped mechanically, so a dry-run report lists each mentor's text for an admin to link by hand |
| `Staff.subjects_teaching` (checked for completeness, never enforced) | `StaffAssignment.subjects`, enforced for doubts and content |
| `TimetableSlot.teacher`, `MentorSlot.mentor_name`, `PersonalDoubt.teacher_name`, notification and scheduler email names | `staff_id` plus a name rendered at send time; recipients resolved by id, never by name match |
| A mentor with `batches_assigned` being batch-scoped as well as mentee-scoped | One scope: mentor = links plus pool (below) |
| `Staff.is_active` + `account_status` | one `status` |

### 4.2 Who creates and assigns whom

| Role | Created by | Assigned how | Sees | Can |
|---|---|---|---|---|
| `super_admin` | bootstrap script | none (global) | everything | billing, staff status/reset/delete, role changes |
| `admin` | `super_admin` | global (a school-level admin is not needed yet) | everything except billing | create instructors and mentors, assign them, manage cohorts and seats; **cannot** disable, reset passwords, delete staff or change roles |
| `instructor` | `admin`/`super_admin` | cohort (+ sections, + subjects), from the cohort page "Teaching staff" or the staff page; both write the same row | their cohorts' students, content, scores, doubts (by subject), timetable, contests and scorecard results | |
| `mentor` | `admin`/`super_admin` | `MentorLink` per seat, or a cohort pool; the promote screen suggests the same mentor for the new seat | linked seats, plus unlinked seats of a cohort they are pooled in | sessions, doubts of their mentees |
| `school_admin` | `admin`/`super_admin` (3b) | school | their school's cohorts and students; no billing | roster import, reports |

**Assignments are written only by admins.** Self-service profile edits must never touch scope: today `updateMyProfile` lets any instructor or mentor write their own `batches_assigned`, `assigned_students` and `subjects_teaching`, which lets them widen their own access (a current security defect, fixed in phase 0). Account status changes only through `setActive` (super_admin, bumps `token_version`); `adminOverrideProfile` loses the ability to flip `is_active`/`account_status`.

**Mentor pool.** A mentor assignment with a cohort and no links is a pool: every pooled mentor sees the cohort's seats that have no explicit link. A mentor with explicit links sees those plus any pool seats; the admin splits a pool into links when wanted.

**Scope for things that are unscoped today.**

| Area | Rule |
|---|---|
| Contests | audience-scoped like other content; instructors see only their cohorts' contests (`listContests`/`getContest` have no filter today) |
| `ScorecardTest` | a global catalog entry (name, type); its **results** (`ScorecardEntry`) are scoped by cohort |
| Instructor directory | admins see all; instructors see colleagues of their cohorts |
| Doubts | instructors by cohort assignment and subjects; mentors by link; community by cohort |
| Mentor slots | `listMentorSlotsMine` matches by `staff_id`, not by name regex; a mentor slot may only target seats the mentor is linked to or pooled for; instructors are not eligible mentors unless they also hold a mentor assignment |

### 4.3 Lifecycle rules (services, each one transaction plus an `AuditEvent`)

- **Reassign an instructor:** end the old assignment, open the new one, and run the existing slot assign/unassign flow for future slots so the old and new teacher are emailed (`timetable-instructor-lifecycle.service.js` compares `staff_id`).
- **Staff leaves:** staff are soft-deleted only (`deleteStaff` hard-deletes today and leaves dangling `staff_id`). Disabling or deleting is blocked until future slots and mentor links are reassigned or explicitly flagged; the offboarding screen lists them.
- **Cohort archived:** its assignments and mentor links get `ends_on`; future slots are flagged.
- **Seat promoted, paused or withdrawn:** the seat's mentor link ends; promote prompts for the new seat's mentor.
- **Content ownership:** content keeps `authored_by` when an assignment ends; an explicit "transfer ownership" action moves it and is audited.
- Every change is effective on the next request: `requireStaffAuth` already loads `Staff`; it also loads the role and active assignments from the database (the JWT role is a hint only and is not trusted, so a role change applies at once) and sets `req.scope = { schoolIds, cohortIds, sectionIds, subjects, seatIds }`. `token_version` is not bumped for assignment changes (it would log the person out).

### 4.4 Permissions and UI

Permissions are named strings in one table in code (`assignments:write`, `students:read`, `seats:promote`, `billing:manage`, `staff:assign`, `staff:status`, ...). `requirePermission(name)` plus shared scope helpers replace about 40 role arrays and about 45 scope branches. Admin UI changes: `StaffPage` and `InstructorBatchPicker` give way to an assignment editor; `ProfilePage` loses the scope fields; `AdminTimetablePage` lists only instructors assigned to the cohort and section (free-text teacher goes away); `AdminMentorSlotsPage` picks from the mentor's links; `StudentDetailCard` shows the seat's mentor with a change action; the cohort page gets a "Teaching staff" tab; navigation and `ProtectedRoute` read the permission list instead of role strings.

### 4.5 Setup flow for a new school

Create `School` → create `Cohort`s (program, fee plan, sections) → assign instructors → import the roster (students plus seats, dry run first) → assign mentors → invite `school_admin`. The admin UI shows this as a checklist computed from data.

## 5. Each role's view

| Role | What they do |
|---|---|
| Student | One login, a list of their courses; each course shows its own XP, assignments, scores, leaderboard and doubts; finished courses stay as transcripts |
| Admin / super_admin | Search-first intake; add seat; promote or bulk-promote; pause; manage cohorts, staff and assignments; billing (super_admin) |
| Instructor | Rosters and content for assigned cohorts and sections; scores; timetable; doubts from their students |
| Mentor | Mentee list by seat; slots; doubts from mentees |
| School admin | Their school's cohorts and students, roster import, reports |
| Finance | Invoices per seat; waived, paused and cancelled handled; reconciliation by cohort |

## 6. Billing

- Invoices keep `enrollment_id`, `course_id` (the fee plan; the field name stays until the last phase) and `student_id`; add `cohort_id`, `program_id`, `period_key` (`2026-11`; `upfront` and `one-off:<number>` for others, backfilled from `period_start`, which can be null).
- Unique index `{student_id, program_id, period_key}` where `status ∈ {pending, paid, failed, refunded, partially_refunded, waived}`: one invoice per student, program and month, which also settles the month of a promotion (the seat active on day 1 owns that month; the new seat bills from `billing_from`).
- The **registration discount** is person-level: tied to the student's first invoice ever (`Invoice.exists({student_id})`) and consumed even when the first bill is fully waived. This fixes a current bug too.
- **Scholarship and Student-of-the-Month use the seat's own results.** A new seat gets none from the old one; an admin can add a manual adjustment.
- Zero-due invoices are created `waived` (excluded from reconciliation). Paused and withdrawn seats generate nothing. The scheduler runs on day 1 and as a daily catch-up for seats whose `billing_from` has passed without an invoice.
- Student stays the payer; a guardian collection, payer fields and sibling-combined invoices are deferred.

## 7. Tenancy checklist (before the first school)

| Area | Change |
|---|---|
| Support | `host_school_id` on `SupportConversation`; `admin-support.controller` lists through `req.scope` |
| Notifications | `StaffPanelNotification` gets a school audience; student `Notification` carries the cohort |
| Announcements | A school admin's announcement gets `owner_school_id` and a school-bounded audience; `everyone` is platform staff only |
| Doubts, community | Carry the cohort; staff lists use `req.scope` |
| Leaderboards | Cohort-scoped; names and avatars shown to cohort-mates only |
| Referrals | Referrer and referee share a school unless allowed; roster import skips referral and discount logic |
| Lookup | `lookupStudentByEmail` returns a boolean for students the caller does not own |
| Staff lists and student list | Hide `last_login_ip`/`last_login_user_agent` from everyone except `admin`/`super_admin` |
| Student-facing profile | Stop returning guardian fields |

Cross-school student: a school admin sees the student's name and the seat their school hosts, nothing about other seats.

## 8. Growth, integrity, privacy

- "Who is in cohort X" is a query on seats joined to students, replacing `studentIdsInBatches`. Notification fan-out uses chunks of 1000 with `ordered: false`. Lists use cursor pagination. Index builds run from an explicit script, not `autoIndex`. `AuditEvent` {`actor_id`, `action`, `target_type`, `target_id`, `data`, `at`} is append-only and indexed on `{target_id, at}`.
- Roster import (about 300 rows): dry run first; dedupe email → CST id → normalised guardian phone + name + grade (matches flagged, never auto-merged); a match at another school adds a seat to the existing student; no referral or discount logic.
- Privacy: guardian fields staff-only and removed from student-facing endpoints; archive means seats ended, name → "Former student", contact and IP wiped, support and doubt text redacted, invoices kept. Retention periods are an owner decision.

## 9. Migration (expand, migrate, contract)

Every script is dry-run by default, backs up first and never deletes. Enrollment `_id`s are unchanged. The existing `BATCH_MEMBERSHIP_SOURCE` flag style is the read-switch; dual-write stays until the last phase so rollback is a code revert.

| Phase | Work |
|---|---|
| 0 | Run the duplicate-invoice cancel; mark the 8 orphan seats `completed`; reject the stale payment proof. **Security fix:** stop `updateMyProfile` from writing `batches_assigned`, `assigned_students` and `subjects_teaching`. Fix the two `$ne` partial indexes (`StudentEnrollment` roll number, `Notification` dedupe) and build them with a script (**the roll-number index is missing in production today**). Fix the registration-discount rule. |
| 1 | Add `School`, `Program`, `Cohort`, `AuditEvent`; seed `codemasti`, 5 programs, 5 cohorts; map `school_name`; point fee plans at cohorts. |
| 1.5 | Tests first, on a MongoDB replica set: seats, promote, invoice generator, audience module. |
| 2a | Evolve `StudentEnrollment` (new fields, `cancelled`→`withdrawn`, `is_primary`, `billing_from`); `resolveSeat` and the `enrollment_id` request parameter replace `scopeStudentToBatch` and `?batch_id=`; add `addSeat`, `promote`, `pause`, search-before-create; **portal:** course switcher on `enrollment_id`, read-only paused and completed seats, per-seat profile, dashboard, achievements, streak and leaderboard; port or retire the scripts that key on `batch_id`. |
| 2b | **Backfill `enrollment_id` and `cohort_id` onto every learning record, with a quarantine report and no write on ambiguity.** Rule: key on `(student_id, batch_id)` and write only when exactly one seat (any status) matches. `ScorecardEntry`: exact. Submissions and XP grants: the assignment's batch (or the one of its `batch_ids` the student is in; if several, the seat whose dates cover `submitted_at`); empty-batch content goes to the primary seat active at that time and is reported for multi-seat students. Badges: the seat active at `awarded_at`. `MonthlyLeaderboardBadge`: `scope_key` → batch → the student's seat there. `MentorSessionJoin`: slot batches ∩ the student's seats. `PersonalDoubt` and `CommunityMessage`: the primary seat at `createdAt`. `StudentLeaderboardGapState`: reset. Reactivated or transitioned seats (`transitionEnrollment` already creates a second seat) map to the latest seat and are flagged. Then switch reads and writes and add the seat-scoped unique indexes. |
| 2c | `audience.js` and `audience_keys`; convert each targeted collection; delete the eight filters. |
| 2d | Leaderboard, badge, XP and community keys to cohort and seat. |
| 3a | `StaffAssignment`, `MentorLink`, `requirePermission`, scope helpers; replace every `getInstructorAssignedBatchIds` caller; offboarding and reassignment services; admin UI assignment editor, cohort "Teaching staff" tab, timetable and mentor-slot pickers; scope contests, scorecard results, doubts and the instructor directory. |
| 3b | Tenancy checklist, then `school_admin` and the first school. |
| 4 | Billing: new invoice fields, `period_key` backfill and duplicate check, partial unique index, `waived`, scheduler catch-up. |
| 5 | Contract: remove legacy fields and `BatchCatalog`. |

The apps send `?batch_id=`; the server maps it to a cohort id during the transition, so the frontends change once, in 2a.

## 10. Risks

- Phases 2 to 4 touch most controllers; the repo has no tests (hence 1.5).
- Transactions need a replica set; the double-billing guard so far has stub tests only.
- A seat that was reactivated or transitioned earlier (the admin `transitionEnrollment` already completes one seat and opens another) can hold records from two periods; the backfill maps them to the latest seat and flags them for review.
- Submit endpoints carry no seat today; until 2a ships, untagged content cannot say which seat earns, so 2a must land together with the portal change.
- Partial filters with `$in` need a recent MongoDB; confirm the Atlas version.

## 11. Deferred on purpose

Guardian collection and parent login; payer and sibling-combined billing; leads and admissions pipeline; certificates; school contracts and billing a school; content/publication split; an audit-reading UI.

## 12. Open questions for the owner

1. **Pathway.** Is Spark → Builders → Innovators a real progression (so promote can suggest the next course)?
2. **Mentors.** Does a mentor follow a student into the next course, or is a new mentor chosen each time? The design links to the seat and suggests the same mentor on promote. Is a cohort "pool" of mentors something you use, or is it always one mentor per student?
3. **School students' login.** They may have no personal email; phone OTP or school-issued emails must be decided before the first school (launch blocker).
4. **`school_admin` powers.** Assumed: create and edit students and seats of their own school, view reports, no billing.
5. **Who creates instructors for a school.** Assumed `admin`/`super_admin` now, `school_admin` later.
6. **Retention** of ended seats and support history.

## 13. Review log

- v1 (code): missing batch-keyed collections, audience gaps, billing index and credit rules, token coupling, migration order.
- v2 to v3 (finance, school/privacy, engineering): registration discount re-firing, promotion month, pause and scheduler, fee override, waived invoices; support/notification/announcement/doubt school filters, guardian exposure, roster import, login, consent; audience matching keys, `$ne` partial indexes (already failing in production), id preservation, races, over-scoped pieces cut.
- v4: owner rules 2 and 3 (seat-owned records) and staff assignment flows.
- v4.1 (record scoping and staff flows, from the code): submission uniqueness was wrong (multi-attempt), XP-grant, badge, gap-state, scorecard and mentor-join indexes collide per seat, `PersonalDoubt` has no cohort, no submit request carries a seat, arena submit has no membership check, dead `Student.xp` write; backfill ambiguities and a quarantine rule; instructors can edit their own scope via `updateMyProfile`, contests and scorecard tests are unscoped, timetable and mentor slots match staff by name, hard delete leaves dangling ids, `admin` powers contradicted today's rules, mentor pool undefined.
