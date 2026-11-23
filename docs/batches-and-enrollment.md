# Batches and enrollment (current behaviour)

This replaces the planning document archived at [archive/BATCH_MULTIBATCH_MIGRATION_PLAN.md](archive/BATCH_MULTIBATCH_MIGRATION_PLAN.md), which was written before the migration was implemented. Everything below was checked against the code.

## Model

| Concept | Where | Notes |
|---|---|---|
| Batch registry | `BatchCatalog` (`src/models/BatchCatalog.js`) | `batch_id` (unique, lowercase), `name`, `order`, `sections[]`, `enrollment_prefix` (uppercase, up to 6 letters, partial-unique), `tier_label`, `is_protected`, `is_active` (soft retire), `include_in_default_views`, `recording_drive_folder_url`. |
| In-memory registry | `src/utils/batch-catalog-registry.js` | Seeded with `spark` (S), `builders` (B), `innovators` (I) so the three original batches work before the DB is read; DB rows overlay the seed. 60 s TTL snapshot, `refresh(true)` after catalog writes. It does not carry `sections`. Per-instance memory: other instances see changes within the TTL. |
| Membership (source of truth) | `StudentEnrollment` | One row per student x course. Fields `batch_id` (denormalised from `Course.linked_batch_id` by a pre-save hook), `section_id` (per batch), `roll_number` (per batch), `source`, `status` (`active`/`completed`/`cancelled`). Indexes: `{batch_id,status}`, `{student_id,batch_id,status}`, unique `{student_id,course_id}` for active/completed, unique `{batch_id,roll_number}` when set. |
| Billing record of a batch | `Course.linked_batch_id` | Exactly one **active** course per batch (409 `BATCH_HAS_ACTIVE_COURSE`); a course cannot be re-linked while it has active enrollments (409 `COURSE_RELINK_BLOCKED`). Creating a batch auto-creates a fee-0 placeholder course (best-effort). |
| Primary-batch display cache | `Student.batch_id`, `batch`, `section_id`, `enrollment_number` | The student's "home" batch. Not authoritative for membership. `recomputePrimaryBatchCache` only fills it when empty. |

`BATCH_MEMBERSHIP_SOURCE` no longer exists in code: membership is always enrollment-based. The older letter-prefix derivation (`utils/enrollment.js`: `catalogBatchIdsFromStudentLean`, `catalogBatchMongoMatch`) still exists as a fallback when no resolved set is attached to the student object, and for a few admin counts.

## How membership resolves today

`src/utils/student-batch-context.js`:
- `enrollmentBatchIdsForStudent(studentId)`: active enrollments -> batch ids (+ per-batch section). Falls back to `Course.linked_batch_id` for enrollment rows missing `batch_id`.
- `resolveStudentBatchContext(req, student)`: reads `?batch_id=`; honoured only if the student has an **active** enrollment in that batch (checked on `StudentEnrollment.batch_id`, then via the course link); otherwise ignored.
- `scopeStudentToBatch(req, student)`: used by student-facing controllers (arena, assignment, contest, dashboard, doubts, mentor-sessions, notes, student scorecard, student, timetable, plus `assignmentEligibility`). It attaches `__membershipBatchIds` / `__membershipSectionByBatch` to the in-memory lean student; when a batch was explicitly picked it also overrides `student.batch_id`, clears `enrollment_number`, and uses that batch's section. `catalogBatchIdsFromStudentLean` returns the attached set when present.
- Cohort helpers (`studentIdsInBatches`, `studentsInBatchesFilterResolved`, ...) answer "who is in batch X" from active enrollments. Dedup is done in application code because the Mongo connection uses `serverApi.strict: true`, which bans `distinct`.
- `historicalEnrollmentBatchIdsForStudent` also includes `completed` enrollments, for history-only reads (past contests/invoices).

## Course picker (`?batch_id=`)

1. Portal calls `GET /v1/students/courses` (enrollments with `course.linked_batch_id`); `SelectedCourseProvider` stores the choice in `localStorage` key `codemasti_selected_batch_id`.
2. `lib/auth-client.ts` appends `?batch_id=<selected>` to batch-scoped API paths (skipped for `/auth/`, `/students/me`, `/students/courses`, `/students/payments`, `/referral`, `/leaderboard`).
3. The server validates the batch against the student's active enrollments (above) and scopes that request to the single batch. Without a valid `batch_id` the student sees the union of their active batches.
4. `GET /v1/leaderboard` and `/leaderboard/me` take `batch_id` themselves (validated against the student's batches; default primary, else first) and return `selected_batch_id` + `batches[]`; XP and cohort are both scoped to that batch.

## Enrollment numbers (primary roll) and per-batch roll numbers

- **Input validation** (`admin.controller.js` `createStudent` and `updateStudent`, Zod): `^[A-Za-z]+\d{6}$` (one or more letters + 6 digits, e.g. `I260105`, `SU260206`).
- **Parsing** (`utils/enrollment.js` `parseEnrollmentNumber`): uppercased, split into `prefix` + `YY` + `SS` (section) + `RR` (roll). The prefix must resolve to a batch through the registry (built-in S/B/I seed + `BatchCatalog.enrollment_prefix`); otherwise 400 `INVALID_ENROLLMENT_NUMBER` ("create a batch with this enrollment_prefix first"). The derived `batch_id` seeds `Student.batch_id`.
- **Batch prefix rules** (`admin-batch-catalog.controller.js`): `^[A-Z]{1,6}$`, unique across the catalog and the built-in seed.
- **Next number** `GET /v1/admin/students/next-enrollment?batch_id=&section_id=`: `<PREFIX><YY><SS><RR>`, smallest free `RR` in 01..99 for that prefix/year/section (`SECTION_FULL` when exhausted; `NO_PREFIX` if the batch has no prefix). Known issue: the section code looks up `registry.getBatchSync(...).sections`, which the registry never populates, so a non-numeric section id always maps to `01`.
- **Per-batch roll number** (`StudentEnrollment.roll_number`): for secondary batches added later, `generateRollNumberForBatch` creates `<PREFIX><YY><4-digit seq>` (e.g. `B260012`), unique per batch (retries on a duplicate-key race). It is `""` if the batch has no prefix. For the student's primary batch, `createStudent` stamps `roll_number = enrollment_number` on the first enrollment.

## Admin endpoints

All under `/v1/admin`; roles from [api/ROUTES.md](api/ROUTES.md).

| Endpoint | Roles | Behaviour |
|---|---|---|
| `GET /batches` | SA, A, I, M | List active batches (soft-retired hidden; instructors/mentors see only their assigned batches). Also upserts the three default batches (`ensureDefaultBatches`) on every call |
| `POST /batches` | SA, A | Create batch (validates prefix uniqueness, sections, Drive folder URL), refreshes registry, auto-creates placeholder course |
| `GET /batches/:batch_id`, `GET /batches/:batch_id/students` | SA, A | Detail / roster (active enrollments) |
| `PATCH /batches/:batch_id` | SA, A | Update (name, order, sections, prefix, ...) |
| `DELETE /batches/:batch_id` | SA, A | **Soft retire** (`is_active=false`). Protected batches (`spark`, `builders`, `innovators`) refused; 409 `BATCH_HAS_ACTIVE_STUDENTS` unless `?force=1` |
| `POST /students` | SA, A | Create student from `enrollment_number`; auto-creates the matching enrollment (`meta.enrollment_sync`) |
| `PATCH /students/:id` | SA, A | If the derived batch changes (enrollment number renamed), `syncEnrollmentToBatch` completes the old-batch enrollment and creates/reactivates the new one |
| `POST /students/:id/batches` `{batch_id, section_id?}` | SA, A | **Additive** add-to-batch (`addStudentToBatch`): reuses a completed/cancelled enrollment or creates one with a per-batch roll number; never touches other enrollments. 400 for unknown/inactive batch, 409 `NO_COURSE_FOR_BATCH` if no active course is linked. Then `recomputePrimaryBatchCache`. |
| `DELETE /students/:id/batches/:batch_id` | SA, A | Targeted remove (`removeStudentFromBatch`): completes that batch's active enrollment(s) and **cancels their pending invoices** (paid ones kept). |
| `GET /students/:id` | SA, A, I | Includes `batches[]` (batch + roll) |
| `GET|POST /enrollments/reconcile` | SA | Additive reconcile of `Student.batch_id` vs active enrollments (`reconcileAllStudents`; never completes other enrollments) |

## Billing interplay

Invoices hang off `enrollment_id` + `course_id`, so a student in two batches gets two invoices per month (separate fees). Registration discount and referral credit apply only to the primary-batch invoice. Scholarships and Student-of-the-Month are looked up per course's linked batch. Removing a student from a batch cancels that batch's pending invoice; no proration, no auto-refund. See [BILLING.md](BILLING.md).

## Backfill scripts (`src/scripts`, dry-run unless `--apply`; check each header)

Remaining: `backfill-enrollment-section-id` (stamps `section_id` on enrollments from the student's legacy section), `backfill-instructor-batches-all-catalog` (resets every instructor's `batches_assigned` to the full catalog, so it is a reset tool, not a migration) and `debug-enrollment-sync` (read-only).

The other backfills (`backfill-batch-catalog-fields`, `backfill-enrollment-batch-id`, `backfill-enrollment-roll-number`, `backfill-classjoinaudit-batch-id`, `backfill-enrollments`, `migrate-timetable-event-types`, `retag-subjects-to-catalog`), `migrate-staff-static-media` and `check-membership-parity` were removed on 2026-11-23 after a read-only check of the production database showed each had nothing left to change. They remain in git history.

## Edge-case register (still true in code)

| Area | Current behaviour / risk |
|---|---|
| Two student-move mechanisms | Renaming `enrollment_number` across batches (`syncEnrollmentToBatch`) completes the old enrollment, while add/remove-batch is additive. Using the rename on a multi-batch student closes only the old primary batch's enrollment but leaves the others; admins should prefer add/remove. |
| Primary cache staleness | `recomputePrimaryBatchCache` only fills an **empty** `Student.batch_id`. Removing the primary batch leaves `batch_id`/`batch` pointing at it until fixed manually. |
| Single `section_id` on Student | Section-scoped reads use the per-batch enrollment section; `Student.section_id` is only the primary section. Sections are largely unused ("no sections for now" product decision). |
| No active course for a batch | Add-to-batch returns 409 `NO_COURSE_FOR_BATCH`; a placeholder course has fee 0, so no invoices are generated until a super_admin sets the fee. |
| Registry staleness | Each instance refreshes its registry every 60 s; a new batch/prefix may be unknown on other instances for up to a minute. |
| Personal doubts | `PersonalDoubt` has no `batch_id`; a multi-batch student's doubt is visible to staff of every batch they are in. |
| Per-batch counts | Batch `student_count`s are per `(student,batch)`; do not sum them for platform totals. |
| Billing policy | Per-batch invoices; mid-month join billed on the next run; leaving cancels the pending invoice; no auto-refund. These were product decisions, implemented as described. |
| Legacy fallbacks | Code paths that never call `scopeStudentToBatch` (some admin/staff views) still derive membership from `Student.batch_id` + the enrollment-number prefix. |
