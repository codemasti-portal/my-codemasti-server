# Schema redesign proposal (v3: student lifecycle, reviewed three ways)

Status: **proposal, nothing implemented.** Written 2026-11-23. Version 1 copied today's app shape. Version 2 was redrawn from the student lifecycle around one owner rule. Version 3 applies reviews from finance, school-partner/privacy and engineering perspectives, each checked against the code (section 10).

**The rule:** a student who is already known is never registered or enrolled again.

## 1. How the rule is met

A student is **registered once**, gets one permanent `student_code`, and keeps one profile for life. Everything later changes *what they attend*, never *who they are*.

| Situation | What staff do | What the system does |
|---|---|---|
| Known student (returning, second course, workshop) | Types email, phone or name in intake | Search runs first; staff pick "add a seat" on the existing profile |
| Keeps studying month after month | Nothing | The seat is open-ended (no term, no expiry); billing continues |
| Finishes Spark, moves to Builders | One "promote" (or one bulk promote for a cohort) | Closes the old seat, opens the next; code, XP, badges and history carry over; no registration discount again |
| Leaves and comes back | "Add a seat" on the old profile | Same student, same code, history intact |
| Pauses | "Pause" | No invoices while paused; resume later |

Duplicates are blocked by the database: **email is a hard unique key**; phone is a warning with staff override (siblings share a guardian phone); a server-side search runs before every create.

## 2. Flow and principles

`Intake → Placement → Learning → Billing → Progression → Exit/Return`

- **People are permanent, seats are temporary.** Identity never encodes where someone studies (today `I260105` encodes the batch).
- **Facts belong to the student, scope is a tag.** XP, badges, scores and submissions stay with the student; the cohort is context for visibility and leaderboards.
- **Evolve, do not replace.** `StudentEnrollment` keeps its `_id`s (invoices point at them); new fields are added in place.
- **One concept, one place.** Seats only in `StudentEnrollment`; staff scope only in `StaffAssignment`; targeting only in one audience shape with one module.
- **Open-ended by default.** Dates are optional facts.
- **Explicit over implicit.** "Everyone" is a flag; an empty list means nothing.
- **Soft states.** Nothing in the migration deletes data; archived rows are hidden by one shared query scope.
- **Build the seam, not the feature.** Payer, leads, certificates, school contracts, sibling-combined invoices are deferred.

## 3. Target model

### 3.1 People

| Model | Key fields |
|---|---|
| `Student` (identity) | `student_code` (unique, stored, never parsed), `name`, `email` (unique, normalised), `phone`, `whatsapp`, `home_school_id`, `guardian` {`name`, `phone`, `email?`} (embedded; staff-only), `consent` {`purpose`, `version`, `given_by`, `at`}, `external_ids.cst_registration_id`, `avatar_url`, auth fields, `archived_at` |
| `School` | `code` (unique), `name`, `kind` (`direct`/`partner`/`other`), `status`, `city`, `settings` {`branding`, `seat_cap`, `contract_from`, `contract_to`} |
| `Staff` (identity) | `name`, `email`, `phone`, `status` (one enum), `token_version`, auth fields |
| `StaffAssignment` | `staff_id`, `role`, `school_id?`, `cohort_id?`, `section_id?`, `subjects[]`, `active` |

Mentees: `Staff.assigned_students` becomes an `ObjectId[]` for now (no new collection). `Student.home_school_id` is information; who *delivers* a cohort is `Cohort.host_school_id`, and that drives staff visibility. A guardian collection, payer and sibling-combined billing are deferred (section 9).

### 3.2 Structure

| Model | Key fields |
|---|---|
| `Program` (replaces `BatchCatalog`) | `code`, `name`, `kind` (`pathway`/`workshop`/`bootcamp`/`event`), `level`, `next_program_id?` (used only to suggest promotion targets), `is_active`, `recording_drive_folder_url` |
| `Cohort` | `program_id`, `host_school_id`, `fee_plan_id`, `name`, `academic_year?`, `starts_on?`, `ends_on?`, `status`, `sections[]` (embedded `{_id, code, name}`) |
| `FeePlan` (today's `Course`, kept; loses `linked_batch_id`; `course_id` field names stay until the last phase) | `code`, `name`, `base_fee_paise`, `billing_mode`, `is_active` |

`program_id` and `host_school_id` of a cohort never change after creation. Cohorts and programs are read directly (or with a short TTL and `refresh` on write), not from the per-process 60-second `batch-catalog-registry`, which is wrong on several instances.

### 3.3 Seats: `StudentEnrollment`, evolved in place

New and changed fields: `cohort_id`, `program_id` and `host_school_id` (copied, immutable), `section_id?`, `grade` (the student's grade at that seat, replacing the stale single value on `Student`), `status` (`active`/`paused`/`completed`/`withdrawn`; legacy `cancelled` is mapped to `withdrawn` explicitly), `end_reason` (`promoted`/`graduated`/`left`/`transferred`), `is_primary`, `billing_from` (first period to bill; default the next UTC day 1 after `started_on`, so today's "mid-month joiners start next month" policy is explicit and adjustable), `roll_no`, `fee_override_paise?`, `source`.

Invariants as partial unique indexes (operators limited to equality, `$in`, `$type`, `$exists:true`, ranges; **never `$ne`/`$nin`/`$or`**):
- `{student_id, cohort_id}` where `status ∈ {active, paused}`
- `{student_id}` where `is_primary: true` and `status ∈ {active, paused}`
- `{cohort_id, roll_no}` where `roll_no` is a string, with the field omitted instead of `""`

`promote(seat, targetCohort)` is one transaction: complete the old seat (`promoted`), create the next seat, set `is_primary` in an ordered write, **reset `fee_override_paise` unless staff set one**, sync `Student.batch_id`/`batch` to the new primary until the last phase (referral credits still read it), and write an `AuditEvent` inside the same transaction. Bulk promote runs one transaction per student and returns a report of skipped students. `AuditEvent` {`actor_id`, `action`, `target_type`, `target_id`, `data`, `at`} is an append-only collection indexed on `{target_id, at}`.

### 3.4 Roles and scope

Roles: `super_admin`, `admin`, `instructor`, `mentor`, plus **`school_admin`**, launched only after the tenancy checklist (3.6) is done. A `null` assignment field means "all at that level".

| Example | `role` | `school_id` | `cohort_id` | `section_id` |
|---|---|---|---|---|
| Platform owner / admin | `super_admin`, `admin` | null | null | null |
| Instructor, Spark at school X, section A | `instructor` | X | spark-at-X | A |
| Teacher at two schools | two `instructor` rows | X, Y | … | … |
| School coordinator | `school_admin` | X | null | null |

- Permissions are named strings in one table; `requirePermission(name)` and scope helpers replace about 40 role arrays and about 45 `getInstructorAssignedBatchIds` branches.
- `requireStaffAuth` already loads `Staff`; it also loads active assignments and sets `req.scope`. Role and scope come from the database each request, so changes apply at once and `token_version` is **not** bumped (that would log the person out).
- `school_admin` may: create and edit students and seats of cohorts their school hosts, view reports and content. Never: billing routes, `last_login_ip`/`last_login_user_agent`, other schools' students, cross-school lookup.

### 3.5 Targeted content (one audience shape)

Assignment, Contest, Note, Announcement, TimetableSlot, TimetableEvent, MentorSlot and ArenaQuestion embed:

```
audience: { everyone, school_ids[], program_ids[], targets:[{cohort_id, section_ids[]}], student_ids[] }
audience_keys: [String]   // derived on save; the only thing queried
owner_school_id: ObjectId?
```

`audience_keys` holds `all`, `school:<id>`, `program:<id>`, `cohort:<id>`, `section:<cohortId>:<sectionId>`, `student:<id>`. A student query is `{ audience_keys: { $in: seatKeys }, … }` with one multikey index per collection; `seatKeys` is built from the student's 1 to 3 active seats. The structured `audience` exists for the admin UI. `utils/audience.js` owns writing and reading both; the eight hand-written filters (including the un-indexable `$toLower` filter in `utils/assignmentBatchFilter.js`) are deleted. Mapping from today: empty batch becomes `everyone`; `Note.target_section_refs` becomes `targets`; project assignments keep one row per cohort so `creation_group_id` works; `ScorecardTest` is not targeted.

### 3.6 Tenancy checklist (before the first school)

| Area | Change |
|---|---|
| Support | `host_school_id` on `SupportConversation`; `admin-support.controller` lists through `req.scope` |
| Notifications | `StaffPanelNotification` gets a school audience; student `Notification` carries the cohort or school; a school admin sees only its own and platform notices addressed to it |
| Announcements | Created by a school admin → `owner_school_id` and school-bounded audience; `everyone` reserved for platform staff |
| Doubts and community | `PersonalDoubt` and `CommunityMessage` carry the cohort; staff lists use `req.scope` |
| Leaderboards | Cohort-scoped only; names and avatars shown to cohort-mates only |
| Referrals | Referrer and referee must share a school unless the referrer's school allows cross-school; roster import skips referral and discount logic |
| Lookup | `lookupStudentByEmail` returns a boolean for students the caller does not own |
| Payments | Billing routes super_admin only (already enforced); school admin cannot reach `admin-payments`, `admin-manual-payments` |
| Student profile | Student-facing endpoints stop returning guardian fields |

**Cross-school students.** A school admin sees a student's name and the seat their school hosts, nothing about other seats; doubts, support and notifications are tagged per cohort so each host sees only its own; XP and badges belong to the student but score history is shown only for the host's cohorts.

### 3.7 Learning records

`ScorecardEntry`, `MonthlyLeaderboardBadge.scope_key`, `StudentLeaderboardGapState`, `CommunityMessage.channel_id`, XP aggregation and achievement services move from a batch id string to `cohort_id` (the `solo:<id>` form stays). The `ScorecardEntry` unique index gains the cohort. Records stay on the student.

### 3.8 Billing

- Invoices keep `enrollment_id`, `course_id` (fee plan) and `student_id`; add `cohort_id`, `program_id`, `period_key` (`2026-11`; `upfront` and `one-off:<number>` for others, backfilled from `period_start`, which can be null).
- **Unique index** `{student_id, program_id, period_key}` where `status ∈ {pending, paid, failed, refunded, partially_refunded, waived}`: one invoice per student, program and month, which also settles the month of a promotion (the seat active on day 1 owns that month; the new seat bills from `billing_from`).
- **Registration discount** is tied to the student's first invoice ever (`Invoice.exists({student_id})`), not the seat, and the one-time flag is consumed even when the first bill is fully waived. This also fixes a current bug (see phase 0).
- **Zero-due invoices** are created as `waived`, excluded from reconciliation, instead of staying `pending` forever.
- **Pause and scheduler:** paused and withdrawn seats generate nothing. The scheduler runs on day 1 and as a daily catch-up for seats whose `billing_from` has passed without an invoice, so a missed run or a later reactivation is not silently skipped.
- **Policy decisions:** scholarship and Student-of-the-Month follow the student (the prior month's best result across all their seats applies to the first invoice after promotion); `is_primary` replaces `Student.batch_id` in the referral-credit rule.
- Student remains the payer; guardian payment, sibling-combined invoices and a payer snapshot on payments are deferred. Referral and registration credit state stays on `Student`.

## 4. Performance and integrity at growth

- Seat indexes: `{host_school_id, status}`, `{cohort_id, status, section_id}`, `{student_id, status}`.
- "Who is in cohort X" is a query on seats joined to students, replacing `studentIdsInBatches`, which loads id arrays into memory.
- Cohort notification fan-out uses chunks of 1000 with `ordered: false`; the `Notification.dedupe_key` unique index must exist (see phase 0).
- Lists (staff, leaderboard) use cursor pagination. `archived_at` is hidden by one shared scope.
- Index builds run from an explicit script, not mongoose `autoIndex`.
- Roster import (about 300 rows) is a dry-run-first job: email optional if a phone login exists; dedupe order email → CST id → normalised guardian phone + name + grade (matches are flagged for review, never auto-merged); a match at another school adds a seat to the existing student; no referral or discount logic.

## 5. Privacy

| Field | Class | Rule |
|---|---|---|
| name, avatar | personal | visible to cohort-mates (leaderboard) and staff in scope |
| email, phone, whatsapp | contact | staff in scope; never to other students |
| guardian name/phone/email | minor's guardian PII | staff only; removed from every student-facing endpoint |
| last_login_ip, user agent | security | super_admin/admin only |
| consent | legal basis | purpose, version, given_by (guardian or school), date |

Archive/anonymise: seats ended; name → "Former student", email/phone/guardian/ip wiped; support, doubt and community text redacted; invoices kept as financial records. `AuditEvent` also records staff exports of PII. Retention periods are an owner decision.

## 6. Stress tests

| Perspective | Scenario | Outcome |
|---|---|---|
| Admissions | Same child twice, typo in email | Phone/name/CST search flags it; exact duplicates rejected by unique email |
| Student | Spark → Builders | One promote; XP, code unchanged; no second registration discount; override resets |
| Finance | Paused two months | Skipped by the scheduler; resumes at `billing_from`; waived and cancelled invoices handled |
| Finance | Promotion on the 15th | Month already billed to the old seat; new seat bills from the next month; unique index prevents a double bill |
| School partner | 300-student roster | Dry-run import, dedupe, seats in the host cohort |
| School partner | Teacher at two schools | Two assignments; union scope |
| Product | 3-day workshop | Program `workshop`, cohort with `ends_on`, `upfront` plan |
| Compliance | Parent asks for deletion | Archive plus anonymise; invoices retained |
| Engineering | New targeted feature | Embed `audience`, call `audience.js` |
| Growth | 100 schools, 50k students | Indexed seat queries and `audience_keys`; no in-memory id lists |

## 7. Migration (expand, migrate, contract)

Every script is dry-run by default, backs up first and never deletes. Enrollment `_id`s are unchanged, so invoices need no rewrite. The existing `BATCH_MEMBERSHIP_SOURCE` flag style is reused as the read-switch; dual-write stays until the last phase so rollback is a code revert.

| Phase | Work |
|---|---|
| 0 | Data and defects: run the duplicate-invoice cancel; mark the 8 orphan seats `completed`; reject the stale payment proof. Fix the two partial indexes that use `$ne` (`StudentEnrollment` roll-number unique, `Notification` dedupe) and build them with a script. **Production already shows the roll-number index missing**, so uniqueness is not enforced today. Fix the registration-discount rule above. |
| 1 | Add `School`, `Program`, `Cohort`, `AuditEvent`; seed the `codemasti` school, 5 programs, 5 cohorts; map `school_name` to schools; point fee plans at cohorts. |
| 1.5 | **Tests first** on a MongoDB replica set: seats, promote, invoice generator, audience module. |
| 2a | Evolve `StudentEnrollment` in place (new fields, `cancelled`→`withdrawn`, `is_primary`, `billing_from`); switch membership reads; add `promote`, `pause`, search-before-create. Port or retire `backfill-enrollment-section-id`, `backfill-instructor-batches-all-catalog`, `debug-enrollment-sync`, `seed`. |
| 2b | `audience.js` and `audience_keys`; convert each targeted collection; delete the eight filters. |
| 2c | Learning-record, leaderboard and community keys to cohort ids. |
| 3a | `StaffAssignment`, `requirePermission`, scope helpers; replace every `getInstructorAssignedBatchIds` caller. |
| 3b | Tenancy checklist (3.6), then `school_admin` and the first school. |
| 4 | Billing: new invoice fields, `period_key` backfill and duplicate check, partial unique index, `waived`, scheduler catch-up. |
| 5 | Contract: remove legacy fields and `BatchCatalog`. |

The apps send `?batch_id=`; the server maps it to a cohort id in the transition, so the frontends change once, in 2a.

## 8. Risks

- Phases 2 to 4 touch most controllers; the repo has no tests (hence 1.5).
- Transactions need a replica set; the double-billing guard so far has stub tests only.
- The partial-index fixes need a database that supports `$in` in partial filters; confirm the Atlas version.

## 9. Deferred on purpose

`Guardian` collection and guardian login; payer on invoices/payments and sibling-combined billing; leads/admissions pipeline; certificates; school contracts and billing a school; a content/publication split; an audit-reading UI.

## 10. Open questions for the owner

1. **Pathway.** Is Spark → Builders → Innovators a real progression? (It decides whether promote suggests a target.)
2. **Carry-over policy.** The design lets scholarships and Student-of-the-Month follow the student across programs. Confirm.
3. **School students' login.** Needs an identifier beyond email: phone OTP (a WhatsApp or SMS provider) or school-issued emails. Launch blocker for the first school.
4. **`school_admin` powers.** Assumed: create/edit students and seats for their own school, no billing.
5. **Retention.** How long ended seats and support history are kept.

## 11. Review log

- v1 (code review): missing batch-keyed collections, audience gaps, billing index and credit rules, token coupling, migration order.
- v2 → v3 (three perspectives): **finance** (registration discount re-fires per seat, promotion month, pause/return and the day-1-only scheduler, fee override, waived invoices, payer routing); **school/privacy** (support, notifications, announcements and doubts have no school filter, guardian PII exposure, roster import and login, grade and year, consent); **engineering** (audience matching needs derived keys, `$ne` partial indexes that already fail in production, preserve enrollment ids, races in promote and import, over-scoped pieces cut, registry cache).
