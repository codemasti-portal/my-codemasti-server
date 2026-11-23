> SUPERSEDED (2026-11-23): historical planning doc, written before the migration was implemented. See ../batches-and-enrollment.md for current behaviour.

# CodeMasti — Dynamic Batches + Many-to-Many Student↔Batch: Architecture Review & Migration Plan

> Status: **Proposal for review.** No schema, code, or database changes have been made. Dev is wired to the **production** database — every write step below is gated on explicit approval and designed for zero/low-downtime expand-contract rollout.

---

## 1. Executive summary

**The goal:** (1) create new batch types at runtime with no code changes / no hardcoded values; (2) allow a student to belong to **multiple batches at once** (true M:N); (3) migrate safely on prod with backward compatibility and no loss of payment/reporting/historical data.

**The key finding:** the platform is already **mid-migration**. Three of the hardest pieces are *already* effectively M:N and need no migration:

| Already M:N-safe | Why |
|---|---|
| **Billing** | `Invoice` keys off `enrollment_id` + `course_id` (not `Student.batch_id`); `monthly-invoice.scheduler` iterates **active enrollments per course**. A student with 2 active enrollments already gets 2 correct invoices. |
| **Content targeting** | `Assignment.batch_ids[]`, `ArenaQuestion.batch_ids[]`, `Note.target_batch_ids[]`/`target_section_refs[]`, `LiveClass.target_batch_ids[]`, `MentorSlot.target_batch_ids[]` already target multiple batches. |
| **Staff scoping** | `Staff.batches_assigned[]` is already an array. |

**The single-batch assumption is concentrated in the *student identity layer* and the *content-scoping read paths*:**

- `Student.batch_id` is a single string, and `Student.enrollment_number` (the `I/S/B` + 6-digit roll number) **hardcodes exactly 3 batches** and its prefix letter **"wins"** over `batch_id` in membership queries.
- A single chokepoint function — **`catalogBatchIdsFromStudentLean(student)`** in [`utils/enrollment.js`](my-codemasti-server/src/utils/enrollment.js) — converts "a student" into "a set of batch ids." Nearly every read path (instructor scoping, content visibility, admin counts, leaderboard cohorts) calls it or re-implements its single-value logic inline.

**The recommendation:** Make **`StudentEnrollment` the single source of truth for batch membership** (the "reuse the layer you already built" approach), because billing already depends on it and it is already partially backfilled. A student in two batches is simply a student with two active enrollments — a capability the schema *already permits*. Add **one denormalized indexed `batch_id` field** to `StudentEnrollment` so membership is a single indexed query (no `$lookup`). Move every hardcoded batch literal into `BatchCatalog` columns + a cached registry. Keep `Student.batch_id` permanently as a never-empty "primary batch" display cache so the ~50 legacy readers never break.

This was chosen over two alternatives after an adversarial review (see §10 / Appendix B):

- **Rejected — new `StudentBatchMembership` junction collection:** creates a *second* membership graph parallel to `StudentEnrollment`. Because scholarships/invoices key off enrollments, the two graphs can silently disagree → a student "in" a paid batch academically with no enrollment → **revenue leak**. Worse than today.
- **Rejected (as authoritative) — `Student.batch_ids[]` embedded array:** fastest reads, but adds a *third* denormalized field on `Student` to keep in sync; the embed-vs-enrollment drift is the same class of bug we're trying to kill. (We borrow its best idea — the never-empty primary mirror — without making the array authoritative.)

---

## 2. How batch membership works today (current state)

There are **three competing sources of "what batch is this student in,"** which is the root problem:

1. **`Student.enrollment_number` prefix letter** — `I260105` → Innovators, `S…` → Spark, `B…` → Builders. Parsed in [`utils/enrollment.js`](my-codemasti-server/src/utils/enrollment.js): `PREFIX_TO_BATCH`, `CATALOG_BATCH_ID_TO_PREFIX`, regex `/^[ISB]\d{6}$/`. In membership queries (`catalogBatchMembershipOrConditions`, `catalogBatchMongoMatch`) the **letter wins** over `batch_id`.
2. **`Student.batch_id`** (single string, [`Student.js:15`](my-codemasti-server/src/models/Student.js#L15)) + `Student.batch` (display label) + `Student.section_id` (single) — the denormalized fallback.
3. **`StudentEnrollment(student_id, course_id)` → `Course.linked_batch_id`** — the *real* M:N spine ([`StudentEnrollment.js`](my-codemasti-server/src/models/StudentEnrollment.js), [`Course.js:19`](my-codemasti-server/src/models/Course.js#L19)). Currently treated as **secondary** — `enrollment-sync.service.js` keeps it aligned *to* `batch_id`, not the other way around.

**What forbids >1 batch per student today:**

- The enrollment-letter is authoritative and a student has exactly one `enrollment_number`.
- `scopeStudentToBatch` ([`student-batch-context.js:53`](my-codemasti-server/src/utils/student-batch-context.js#L53)) actively **clears `enrollment_number`** in memory to force a single-batch view when the portal picks a batch.
- `reconcileAllStudents` / `syncEnrollmentToBatch` ([`enrollment-sync.service.js`](my-codemasti-server/src/services/enrollment-sync.service.js)) **collapse** a student to one active enrollment: on a batch change they mark the old enrollment `completed` and create the new one. `reconcileAllStudents` only even scans students with non-empty `batch_id`.

**What already supports M:N (latent, unused):** the `StudentEnrollment` partial-unique index is on `(student_id, course_id)` — it blocks duplicate enrollments in the *same* course, but **permits multiple active enrollments in different courses** (hence different batches). The capability exists; the membership-resolution logic just ignores it.

---

## 3. Hidden single-batch assumptions (grounded inventory)

| # | Assumption | Where | Severity | What breaks under M:N |
|---|---|---|---|---|
| H1 | **Enrollment letter is authoritative & hardcoded to 3 batches** | `enrollment.js` `PREFIX_TO_BATCH`, `catalogBatchMembershipOrConditions`, regex `/^[ISB]\d{6}$/` | Critical | A 4th batch type cannot get an enrollment number; the letter can only encode one batch, so it structurally forbids multi-batch. |
| H2 | **`catalogBatchIdsFromStudentLean` returns the derived single batch** | `enrollment.js`; called across instructor scope, timetable, notes, dashboard | Critical | The choke point: every reader that asks "which batches is this student in?" gets ≤1. Fixing this one resolver fixes most reads. |
| H3 | **`scopeStudentToBatch` mutates `batch_id` & clears `enrollment_number`** | `student-batch-context.js:53` | High | A single-batch crutch; destroys the multi-batch context on every portal request that picks a batch. |
| H4 | **`reconcileAllStudents` / `syncEnrollmentToBatch` collapse to one active enrollment** | `enrollment-sync.service.js` | Critical | Genuinely **destructive**: would auto-`complete` a legitimate second batch's enrollment. Must be disabled before backfill. |
| H5 | **`Student.batch_id` / `batch` / `section_id` are single-valued** | `Student.js:13–17` | High | `section_id` can't express "Section A in Spark, Section B in Builders." `batch_id` empty/stale → student loses all assignment visibility. |
| H6 | **`Student.progress` is a single global scalar** | `Student.js:20`; surfaced as `performance_score` in `dashboard.controller.js` | Medium | "Progress in which batch?" is undefined. Progress tracking has no per-batch dimension. |
| H7 | **`referral_benefits_queue` + `registration_fee_discount_percent` are global per-student credits, consumed during invoicing** | `Student.js:56`; `invoice-generator.service.js:108–148` (`nextConsumableReferralCredit`, "zero out registration discount after first use") | Medium | Consumption is atomic per-invoice (own Mongo transaction) and the scheduler bills sequentially, so there's **no race / double-apply**. But each `buildInvoiceForPeriod` re-reads the queue independently, so a *multi-month* referral credit is consumed **once per batch per month** (2 batches → 2 months burned in one calendar month), and the one-time registration discount lands on only the **first-billed** course. Needs an explicit per-student-per-month policy. |
| H8 | **Single-batch content models** | `Contest.batch_id` (required), `Announcement.batch`+`batch_id`, `TimetableSlot.batch_id`, `TimetableEvent.batch_id`, `ScorecardEntry.batch_id` (required) | Medium | These are *content/record* docs legitimately scoped to one batch (a multi-batch student matches if its `batch_id ∈ myBatches`). Only **targeting** multiple batches at once needs an optional array; record-level single `batch_id` is correct. |
| H9 | **`reconcileAllStudents` skips empty `batch_id`** | `enrollment-sync.service.js:147` | Medium | Legacy students with no `batch_id` are never reconciled → orphaned at read-switch. |

---

## 4. Hardcoded batch literals (must move to data)

Requirement #1 ("new batches with no code change") is blocked by these. All move to `BatchCatalog` columns + a cached registry:

| Literal / map | File | Replaced by |
|---|---|---|
| `DEFAULT_BATCHES` (spark/builders/innovators) + `DEFAULT_SECTIONS_BY_BATCH` | `constants/batchDefaults.js` | `BatchCatalog` rows; `is_protected` flag |
| `PREFIX_TO_BATCH`, `CATALOG_BATCH_ID_TO_PREFIX`, regex `/^[ISB]\d{6}$/` | `utils/enrollment.js` | `BatchCatalog.enrollment_prefix` (per-row, sparse-unique) |
| `DISPLAY_BATCH_BY_CATALOG_ID` | `utils/instructorBatchScope.js` | `BatchCatalog.name` |
| `z.enum(['spark','builders','innovators'])` (reassign-batch validator) | `controllers/admin.controller.js` | `z.string()` validated against `BatchCatalog.findOne({batch_id, is_active})` |
| `defaultBatchIds = ["spark","builders","innovators"]` (×2) | `controllers/staff-doubts.controller.js:62,152` | `BatchCatalog` `include_in_default_views` flag |
| `FIXED_BATCHES` + `isSeededDefaultBatch` + `mergeWithDefaults` | `my-codemasti-admin/src/pages/batches/batchConstants.js` | Catalog API (`mergeWithDefaults` already supports "extras"; drop the fixed list) |
| `BATCH_TIER` / `BATCH_LABEL` (if present) | server constants | `BatchCatalog.tier_label` |

> Note: `CommunityMessage.channel_id` is a **string equal to `batch_id`** — the doubt/community channels *are* the batches. New batches automatically get a channel; only the hardcoded `defaultBatchIds` "all channels" view needs to become data-driven (above).

---

## 5. Dependent-entity analysis (the full sweep)

Legend: **OK** = already M:N-safe, no migration; **READ** = change the student-side resolver only; **ADD** = optional additive field for multi-batch *targeting*; **AGG** = aggregation/reporting fix to avoid double-count.

| Entity | Today's batch binding | Under the new model | Class |
|---|---|---|---|
| **StudentEnrollment** | `student_id × course_id`; batch via `Course.linked_batch_id` | **Source of truth.** Gains denormalized `batch_id` + per-enrollment `section_id`. | core |
| **Payment / Invoice / ManualPayment / Refund** | `Invoice→enrollment_id+course_id`; `Payment→invoice_id` | **Unchanged.** Per-enrollment → already correct for M:N. | OK |
| **Monthly invoicing** | iterates active enrollments per monthly course | **Unchanged.** 2 enrollments → 2 invoices. | OK |
| **Scholarship** (`ScorecardEntry` → invoice) | `findLatestScholarship` keyed on `course.linked_batch_id` for the period | **Unchanged.** Resolved per-enrollment-batch. | OK |
| **Referral / registration credits** | `Student.referral_benefits_queue` (global), consumed at invoicing | Needs a **policy + atomic consumption** when a student has multiple invoices/month. | policy |
| **Assignment / ArenaQuestion** | `batch_ids[]` already; visibility = `student.batch_id ∈ scopes` | visibility = `scopes ∩ myBatchIds ≠ ∅` | READ |
| **AssignmentSubmission** | no `batch_id` (keyed by `student_id`+`question_id`) | **Unchanged.** Grades attach to the assignment, not a batch. | OK |
| **Contest** | `batch_id` required (one row per batch; `event_group_id` groups multi-batch schedules) | match if `contest.batch_id ∈ myBatchIds`. No schema change. | READ |
| **ScorecardEntry** | `batch_id` required (one row per student×batch×test) | **Keep per-row `batch_id`** — a score belongs to the batch earned in. Selection of "who's in batch X" uses enrollments. | READ + AGG |
| **MonthlyLeaderboardBadge** | `scope_key` = batch_id (or `solo:<id>`) | one badge per active batch per period; cohort = enrollments in batch. A multi-batch student can win in each (label the batch in UI). | READ + AGG |
| **Leaderboard** | cohort from `student.batch_id` | cohort = `StudentEnrollment.find({batch_id, status:active}).distinct(student_id)`; **additive** (new enrollment → instantly in cohort). | READ + AGG |
| **Timetable (Slot/Event)** | `batch_id` + `section_id` single | `batch_id ∈ myBatchIds`; **section per batch** via enrollment `section_id`. Optional `target_batch_ids[]` for multi-batch targeting. | READ + ADD |
| **LiveClass / Note / MentorSlot** | `target_batch_ids[]` already | `target_batch_ids ∩ myBatchIds ≠ ∅` | READ |
| **Announcement** | `batch` (label) + `batch_id` single; instructor filter uses hardcoded label map | `batch_id ∈ myBatchIds`; instructor filter reads `BatchCatalog.name`. Optional `target_batch_ids[]`. | READ + ADD |
| **CommunityMessage / doubts** | `channel_id` (string) = batch_id; hardcoded default channel list | multi-batch student sees/posts in each of their channels; default list from catalog. | READ |
| **PersonalDoubt / mentor sessions** | inherits student batch context | scope via myBatchIds + `MentorSlot.target_batch_ids`. | READ |
| **Staff scoping (instructor/mentor)** | `batches_assigned[]` already array | `StudentEnrollment.find({batch_id:{$in:batches_assigned}})`; `studentInAnyAssignedBatch` intersects. | OK + READ |
| **Reporting / admin dashboards** | `student_count` per batch via `catalogBatchMongoMatch` (regex) | group by `StudentEnrollment.batch_id`; **dedupe distinct-student totals** (a 2-batch student counts once per batch but once overall). | AGG |
| **Progress** (`Student.progress`) | global scalar | ambiguous; if per-batch progress is desired, it belongs on the enrollment (future). | open |
| **Certificates** | **No model exists** (0 references repo-wide) | future: key to `StudentEnrollment._id` (completion = `enrollment.status="completed"`) → inherits batch + course. | future |

**Confirmed non-existent models** (so they cannot be silently affected): Certificate, Test/TestSession, Channel, generic Badge/StudentBadge, StudentAuditLog. The assessment layer is `ScorecardTest`/`ScorecardEntry`; channels are `CommunityMessage.channel_id`.

---

## 6. Recommended target schema

### 6.1 `StudentEnrollment` — the M:N junction (one new field is the whole structural change)

```js
const studentEnrollmentSchema = new mongoose.Schema({
  student_id: { type: ObjectId, ref: "Student", required: true, index: true },
  course_id:  { type: ObjectId, ref: "Course",  required: true, index: true },

  // NEW — denormalized from Course.linked_batch_id at write time. THE membership key.
  // "" = course not batch-linked (legacy/global); excluded from batch scoping.
  batch_id:   { type: String, default: "", lowercase: true, trim: true, index: true },

  // NEW — per-batch section. Replaces single Student.section_id for multi-batch students.
  section_id: { type: String, default: "", lowercase: true, trim: true },

  status: { type: String, enum: ["active","completed","cancelled"], default: "active", index: true },
  started_on: { type: Date, default: Date.now },
  ended_on:   { type: Date, default: null },
  fee_override_paise: { type: Number, default: null, min: 0 },
  // NEW — provenance/audit (auditability without a separate collection)
  source: { type: String, enum: ["enrollment_number","admin_manual","migration_backfill","self_select"], default: "admin_manual" },
  notes: { type: String, default: "", trim: true, maxlength: 2000 },
  created_by_staff_id: { type: ObjectId, ref: "Staff", default: null },
}, { timestamps: true, versionKey: false });

// existing
studentEnrollmentSchema.index({ student_id: 1, status: 1 });
studentEnrollmentSchema.index(
  { student_id: 1, course_id: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["active","completed"] } } });

// NEW hot paths
studentEnrollmentSchema.index({ batch_id: 1, status: 1 });             // "who is in batch X"
studentEnrollmentSchema.index({ student_id: 1, batch_id: 1, status: 1 }); // "what batches is S in"
```

### 6.2 `BatchCatalog` — the only batch registry (kills every hardcoded literal)

```js
const batchCatalogSchema = new mongoose.Schema({
  batch_id: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  name:     { type: String, required: true, trim: true },        // replaces DISPLAY_BATCH_BY_CATALOG_ID
  order:    { type: Number, default: 0 },
  sections: { type: [sectionSchema], default: [] },              // unchanged

  // NEW — all runtime-editable; remove the hardcoded maps:
  enrollment_prefix:       { type: String, default: "", uppercase: true, trim: true, maxlength: 2 }, // "S"/"B"/"I"
  tier_label:              { type: String, default: "" },        // replaces BATCH_TIER
  is_protected:            { type: Boolean, default: false },    // replaces DEFAULT_BATCHES deletion guard
  is_active:               { type: Boolean, default: true, index: true }, // soft-retire, never hard-delete
  include_in_default_views:{ type: Boolean, default: true },     // replaces staff-doubts defaultBatchIds
}, { timestamps: true, versionKey: false });

// One prefix → at most one batch (preserves enrollment-letter semantics, now dynamic).
batchCatalogSchema.index({ enrollment_prefix: 1 },
  { unique: true, partialFilterExpression: { enrollment_prefix: { $type: "string", $ne: "" } } });
```

### 6.3 `Student` — `batch_id`/`batch`/`section_id` demoted to a never-empty display cache

No field is dropped during migration. Re-document semantics: `Student.batch_id` is now the **primary-batch cache**, recomputed from the primary active enrollment — **never the source, never empty** while the student has ≥1 active enrollment. Add a per-student marker so writers/readers know the regime:

```js
membership_source_of_truth: { type: String, enum: ["legacy","enrollment"], default: "legacy", index: true },
// existing batch / batch_id / section_id / enrollment_number RETAINED (cache + legacy display)
```

> **Why keep `Student.batch_id` forever:** many hot paths already `.select("batch_id")`; a maintained primary cache avoids an enrollment lookup on every `Student` read and guarantees legacy readers never see empty (the #1 outage risk — empty `batch_id` makes `assignmentPublishedVisibleToCatalogBatch` return "all"/none unpredictably). We contract the *derivation logic*, not the field.

### 6.4 Optional additive arrays (only for multi-batch *targeting*)

`Contest`, `Announcement`, `TimetableSlot`, `TimetableEvent` gain an optional `target_batch_ids: [String]` (default `[legacy batch_id]`) only if staff need to author one record for several batches at once. Record-level single `batch_id` stays valid. `ScorecardEntry.batch_id` stays single (a score belongs to one batch).

### 6.5 The one resolver everything funnels through

```js
// utils/student-batch-context.js — enrollment-backed, same return contract as today's helper
async function resolveStudentBatchIds(studentId) {
  const rows = await StudentEnrollment.find({ student_id: studentId, status: "active" })
    .select("batch_id section_id").lean();
  const batchIds = [...new Set(rows.map(r => r.batch_id).filter(Boolean))];
  const sectionByBatch = {};
  for (const r of rows) if (r.batch_id) sectionByBatch[r.batch_id] = r.section_id || "";
  return { batchIds, sectionByBatch };
}
```

---

## 7. Phased migration plan (expand-contract)

**Principles:** additive first → switch reads last (behind a flag) → never drop authority until verified. Every phase runs safely with old and new code concurrently. Each write step requires explicit approval (prod DB).

### Phase 0 — De-hardcode the registry (pure additive, ship FIRST, no membership change)
- Add the new `BatchCatalog` columns; backfill the 3 existing rows (`enrollment_prefix` S/B/I, `tier_label`, `is_protected:true`, `include_in_default_views:true`) via an approved script.
- Build an in-process **`batchCatalogRegistry`** (TTL + invalidate-on-write) exposing `displayName`, `tierLabel`, `prefixToBatchId`, `defaultViewBatchIds`, `isProtected`.
- Repoint `enrollment.js`, `instructorBatchScope.js`, `staff-doubts.controller.js`, the reassign-batch `z.enum`, and admin `batchConstants.js` to the registry.
- **Outcome:** Requirement #1 (new batch types at runtime, no code change) is met **here**, before any membership risk. Students still single-batch.
- **Rollback:** revert deploy; the 3 rows' new columns are ignored by old code.

### Phase 1 — Expand schema + dual-write (readers still legacy)
- Add `StudentEnrollment.batch_id` + `section_id` + `source` and the two new indexes (build `background:true`; field defaults `""` are invisible to current code).
- A `pre('save')` / `pre('insertMany')` hook on `StudentEnrollment` sets `batch_id = course.linked_batch_id` automatically.
- Cascade: when `Course.linked_batch_id` is edited (`admin-courses` `updateCourse`), `updateMany` its enrollments' `batch_id` (ideally same transaction).
- **Disable the destructive paths now:** feature-flag off the "mark the other active enrollment completed" branch in `syncEnrollmentToBatch` and the "collapse to one" path in `reconcileAllStudents`. Replace with explicit additive `addStudentToBatch` / `removeStudentFromBatch` endpoints (the true multi-batch primitive).
- **Rollback:** disable the hook; new `batch_id` values are inert (nothing reads them yet).

### Phase 2 — Backfill (idempotent, online, dry-run-first)
- One re-runnable script: for every `active`/`completed` enrollment, stamp `batch_id` from its course's `linked_batch_id` (process in `_id` ranges).
- **Gap-fill:** for legacy students who have a valid `batch_id`/`enrollment_number` but **no active enrollment**, create the missing active `StudentEnrollment` in the matching course (this is the existing `reconcileAllStudents` *creation* path, kept; the *destructive* branch stays disabled).
- ⚠️ **Gap-fill into a `billing_mode:"monthly"` course is a financial act** — flag those for human review, do not auto-create (see RISK 1).
- Emits a per-student diff report; `--dry-run` writes nothing.
- **Rollback:** `deleteMany({source:"migration_backfill"})` for stamped/created rows; legacy fields untouched.

### Phase 3 — Read-switch (single env flag, union-mode fail-safe)
- Set `BATCH_MEMBERSHIP_SOURCE=enrollment`. The shim resolver now reads enrollments; before the flip it reads legacy fields.
- During the window the resolver runs in **`union` mode**: `myBatchIds = enrollmentDerived ∪ legacyDerived` — a student is **never dropped** by the switch (RISK 2). Per-cohort flip via `membership_source_of_truth`.
- Portal: `scopeStudentToBatch` stops clearing `enrollment_number`; `?batch_id` becomes a *filter over* `resolveStudentBatchIds` rather than an override. Multi-batch UI (tabs / "all my batches") is an additive frontend change that can land any time after.
- **Rollback:** flip the flag back — one line, one deploy. The maintained `Student.batch_id` cache keeps legacy readers correct regardless.

### Phase 4 — Contract (separate sign-off, after a clean reporting + billing cycle)
- Drop `union` mode (pure enrollment). Delete dead code: `PREFIX_TO_BATCH`-driven `catalogBatchMembershipOrConditions`/`catalogBatchMongoMatch`, the `/^[ISB]\d{6}$/` gate, `DISPLAY_BATCH_BY_CATALOG_ID`, `augmentStudentCatalogFieldsFromEnrollment` (becomes no-op then removed), `scopeStudentToBatch`'s `enrollment_number=""` hack.
- `enrollment_number` survives as a display roll-number only. `Student.batch_id` stays as the permanent primary cache.
- **Rollback:** revert the release (shipped independently of 0–3); cache still present.

---

## 8. Backward-compatibility shims (why old readers never break)

1. **Never-empty primary mirror.** `recomputePrimaryBatchCache(studentId)` runs after every membership write (in the same transaction): sets `Student.batch_id`/`batch`/`section_id` from the primary active enrollment. Legacy readers that `.select("batch_id")` always see a valid value — directly kills the #1 outage (empty `batch_id` → no assignments).
2. **Same-signature resolver.** `catalogBatchIdsFromStudentLean(student)` is re-implemented to delegate (flag-gated). Its signature is preserved so the ~50 call sites compile unchanged; new multi-batch sites use `resolveStudentBatchIds`.
3. **`catalogBatchMongoMatch(batchId)`** keeps its signature but, under the flag, returns `{ _id: { $in: <studentIds from StudentEnrollment.find({batch_id, status:active})> } }` — same query shape, enrollment-backed answer. `listStudentsInBatch`, scorecard selection, fanout, leaderboard untouched.
4. **`scopeStudentToBatch`** keeps its name; under the flag it validates `?batch_id ∈ myBatchIds` and returns context, without the destructive mutation.
5. **Registry-backed labels/tiers/defaults** with the hardcoded maps as fallback until Phase 4.
6. **`enrollment_number` stays parseable** so un-migrated portal builds keep working (they just won't see *additional* batches until updated).

---

## 9. Rollback per phase

| Phase | Forward | Rollback |
|---|---|---|
| 0 | registry de-hardcode + catalog columns | revert deploy; new columns ignored |
| 1 | add `StudentEnrollment.batch_id`, dual-write, disable destructive sync | disable hook; values inert |
| 2 | backfill + gap-fill | `deleteMany({source:"migration_backfill"})`; dry-run-gated |
| 3 | read from enrollments (union mode) | flip `BATCH_MEMBERSHIP_SOURCE=legacy` — 1 line; cache keeps legacy correct |
| 4 | delete legacy code, pure enrollment | revert release; cache still present |

---

## 10. Validation & the 5 non-negotiable risk gates

Run as read-only diagnostics throughout (model on existing `debug-enrollment-sync.js`). Phases 3→4 are **gated** on these being green for N consecutive days.

- **RISK 1 — Gap-fill spawns unexpected invoices / pulls unearned scholarships.** Creating a `StudentEnrollment` is a *financial* act (`monthly-invoice.scheduler` bills it; `findLatestScholarship` may apply a discount).
  - **Gate:** *Billing dry-run diff.* Run `runMonthlyInvoiceTick` in dry-run against pre- and post-gap-fill enrollment sets; diff invoice count, `total_due_paise`, `scholarship_discount_paise` per (student, period). Zero unexplained delta. Gap-fills into monthly courses → human review, not auto-create.
- **RISK 2 — Read-switch drops no-enrollment students to `[]` → lose all visibility *and* billing.**
  - **Gate:** *Parity-superset check.* For every student assert `legacy = catalogBatchIdsFromStudentLean(student) ⊆ new = resolveStudentBatchIds(student._id)`. Any `legacy ∖ new ≠ ∅` blocks the switch; run union mode until zero.
- **RISK 3 — Destructive sync collapses genuine multi-batch students.**
  - **Gate:** assert the "complete the other active enrollment" branch is flag-off **before** backfill; scan for any enrollment auto-`completed` with a "moved to batch" note during the window; count students with ≥2 active enrollments in distinct `batch_id` and confirm none were collapsed.
- **RISK 4 — Denormalized `StudentEnrollment.batch_id` drifts from `Course.linked_batch_id`.**
  - **Gate:** *Coverage/equality scan.* Every active enrollment has `batch_id != "" AND batch_id == course.linked_batch_id`. 100% post-Phase-2. Any mismatch = a missed cascade.
- **RISK 5 — Aggregation double-counts; scorecard/leaderboard duplicate rows.**
  - **Gate:** *Synthetic dual-batch fixture test.* Seed one student into 2 batches; assert (a) `scorecardSummary` counts once per batch and dedupes "unique students"; (b) `markAbsentAsZero` creates exactly 2 rows (one per batch, idempotent on re-run); (c) monthly leaderboard finalization iterates the full active batch set, one badge per `(scope_key, period)`, and the portal labels which batch each badge belongs to.

Plus continuous invariants: every active enrollment `batch_id ∈ BatchCatalog{is_active:true}` (orphan-FK scan — also catches `MentorSlot`/`Note`/`Staff.batches_assigned` orphans); exactly one primary active per student; `Student.batch_id ∈ myBatchIds`.

---

## 10b. Prod-safety cross-check (does it break prod / delete old data?)

**No phase in this plan deletes or overwrites historical data.** Verified against the actual operations each phase performs:

| Phase | DB operations | Destructive? |
|---|---|---|
| 0 | add `BatchCatalog` columns (defaulted); build registry | No — additive. Old code ignores new columns. |
| 1 | add `StudentEnrollment.batch_id`/`section_id`/`source` (defaulted); build indexes `background:true`; **disable** the destructive collapse code | No — additive; actually *removes* a hazard. |
| 2 | **UPDATE** (stamp `batch_id` from `course.linked_batch_id`) + **INSERT** (gap-fill missing enrollments) | No deletes. Only the gap-fill *inserts* are a financial side-effect → gated by the billing dry-run (RISK 1). |
| 3 | none (read-only `BATCH_MEMBERSHIP_SOURCE` env flag, union mode) | No writes at all. |
| 4 | delete dead **code** (not data); keep `Student.batch_id` column | No data deleted. |

**The only existing batch-change behavior that could harm a multi-batch student is the auto-"complete" collapse in `enrollment-sync.service.js` / `reconcileAllStudents` — and Phase 1 disables it.** Note it marks `status="completed"` (it never deleted rows), so even today no data is lost; the plan makes this strictly safer.

**Existing destructive endpoints are admin-triggered and unchanged by this plan:** `Student.deleteOne` (admin.controller:1040), `StudentEnrollment.deleteOne` (admin-enrollments:222), `Invoice.deleteOne` (admin-invoices:312), content deletes, and `BatchCatalog.deleteOne` (admin-batch-catalog:213). **Hardening to add in Phase 0:** convert the `BatchCatalog` hard-delete to a soft-retire (`is_active:false`) so deleting a batch can't orphan enrollments/content; the orphan-FK validation gate (§10) backstops this.

**Honest caveat:** this is a *plan*. "Won't break prod" is *enforced at execution time* by the discipline baked in — every write step runs `--dry-run` first, schema/index adds are additive and reversible, the read-switch is a one-line env-flag toggle in union mode (no student ever drops to empty), and Phases 3→4 are gated on the billing dry-run diff + parity-superset checks (§10). It is not provable in the abstract; it is made safe by running each phase behind those gates with per-phase rollback (§9).

## 11. Open decisions for the product owner

1. **Referral/registration credits under multi-batch (H7): ✅ DECIDED — once per student per month.** A global `referral_benefits_queue` credit (and the one-time registration discount) is consumed **once per student per calendar month**, applied to the **primary** batch's invoice. To be implemented in the multi-batch billing phase — no effect today since each student has a single monthly invoice. Implementation note: when generating a student's invoices for a period, consume each global credit at most once across all of that student's invoices for that period.
2. **Per-batch progress (H6): ✅ DECIDED — yes, per-batch.** `Student.progress` (global scalar) becomes a per-enrollment `progress` field on `StudentEnrollment` (additive, later phase); `Student.progress` retained as a legacy/primary cache during transition.
3. **Multi-batch *targeting* of content: ✅ DECIDED — per-batch authoring (default).** No `target_batch_ids[]` added to Contest/Announcement/Timetable; staff author one record per batch (Contest already groups multi-batch schedules via `event_group_id`). Revisit only if authoring friction appears.
4. **Certificates: ✅ CONFIRMED — none exist today** (0 references repo-wide). Future certificates key to `StudentEnrollment._id` (completion = `enrollment.status="completed"`), inheriting batch + course.
5. **Portal multi-batch UX: ✅ DECIDED — one batch at a time.** Keep the existing **CourseSwitcher** dropdown ([course-switcher.tsx](my-codemasti-com/components/layout/course-switcher.tsx)); a multi-batch student switches the active batch and the portal scopes to one via `?batch_id=`. No combined "all my batches" view. This simplifies the read-switch (the picker behavior barely changes) and matches today's UX.
6. **Admin frontend de-hardcoding: ✅ DONE (Phase 0 follow-up).** The admin app no longer hardcodes Spark/Builders/Innovators (`FIXED_BATCHES`, `isSeededDefaultBatch`, `BATCH_TIER`, `BATCH_LABEL`); batch name, tier, order, and protected-status now come from the catalog API.

---

## 12. Read-switch implementation blueprint (from the call-site audit)

A multi-agent audit mapped **every** live call-site of the legacy membership helpers: **~70 call-sites across 27 files, zero missed** (exhaustive whole-repo sweep). The new resolver's safety was adversarially verified: default `legacy`, invalid→`legacy`, `union` never drops a batch, and it's inert until wired. (The audit also caught and we fixed a false-negative in the parity script — it must read the *raw* `catalogBatchIdsFromStudentLean(student)`, not the augmented doc.)

The switch splits cleanly into two categories:

**A. Per-student visibility** (timetable, classes, notes, assignments, arena, contest, dashboard, announcements, doubts, mentor-sessions, student-scorecard, student leaderboard) — the student doc + id are in scope and the functions are already `async`. **Strategy: precompute-and-attach.** Make `scopeStudentToBatch` (the existing injection point, already called in most of these) and a small `attachMembership(student)` helper set `student._membershipBatchIds = (await resolveStudentBatchIds(student)).batchIds` under the flag; then `catalogBatchIdsFromStudentLean` returns that attached set when present, else legacy. This converts ~15 attach-points + 1 chokepoint instead of rewriting all 70 sites. Difficulty: trivial/easy.

**B. "Students in batch X" (cohort / filter)** (notification fanout, admin rosters & counts, scorecard student selection, leaderboard cohort, monthly-badge cohort) — these build a `Student.find()` filter via `studentsInCatalogBatchesFilter` / `catalogBatchMongoMatch`, with **no student id**. Rewrite to resolve members via enrollment: `StudentEnrollment.find({ batch_id, status:"active" }).distinct("student_id")` → `Student.find({ _id: { $in } })`. Add one helper `studentIdsInBatchesViaEnrollment(batchIds)`. Difficulty: medium.

**Blockers (hard) — need an explicit decision each:**
- `monthly-leaderboard-badge.service.js` `scopeKeyForStudentLean` / `distinctScopeKeys` — sync iteration over all students; batch-resolve the whole cohort's memberships up-front (one `StudentEnrollment` query) and pass a `Map` into the iterator.
- `admin.controller.js` `studentResponse()` (sync response formatter, used by create/get/list/update) — this is **display only**; keep it on the `Student.batch_id` primary cache (no async needed). Access control never flows through it.
- `instructorBatchScope.js` `studentInAnyAssignedBatch()` — add an async variant backed by `enrollmentBatchIdsForStudent`; callers (getStudent/listStudents) are async.
- `admin-content.controller.js` `studentMatchesAnnouncement()` in fanout — batch-resolve memberships for the candidate student set before the loop.

**Rollout:** ship all of the above **flag-gated and inert** (default `legacy`). Then in a test/staging pass: flip `BATCH_MEMBERSHIP_SOURCE=union` (fail-safe), run `check-membership-parity.js` until **would-be-dropped = 0**, validate per subsystem, then flip to `enrollment`. Production flip is gated on the parity script being green on real data (RISK 2) **and** the billing dry-run diff (RISK 1).

**Prerequisite before this is meaningful:** Phase 0/1 deployed + both backfills run, so enrollments actually carry `batch_id`. Until then the parity gate can't be green.

### Read-switch implementation status (flag-gated; `legacy` = verified byte-identical no-op)

Foundation (done + adversarially verified): chokepoint attach (`catalogBatchIdsFromStudentLean` returns `student.__membershipBatchIds` when present), `scopeStudentToBatch`/`resolveStudentBatchContext` attach under non-legacy, cohort helpers (`catalogBatchMongoMatchResolved` / `studentsInBatchesFilterResolved` / `catalogBatchStudentFilterResolved`) returning the exact legacy filter in legacy mode, `membershipKeysOr(student, legacyFallback)` helper. Audit verdict: chokepoint/attach **sound**; cohort helpers fixed (removed a `{section_id:null}` divergence).

**Wired (read-switch complete except admin-display analytics):**
- Student content visibility: `assignment.controller` (isAssignmentVisibleToStudent gate, list, filters), `arena.controller` (list, detail), `dashboard.controller`, `contest.service` (batchMatches, listContestsForStudent, pickDashboardContestCard), `classes.controller` (studentClassVisibilityFilter, classVisibleToStudent).
- Notification fanout: `student-notifications.service`, `assignment-notifications.service`.
- Admin cohort/rosters: `admin-catalog` (×3), `admin-batch-catalog` (count + roster), `admin-scorecard` (spreadsheetStudents, markAbsentAsZero, assertStudentInBatch). `admin-scorecard.listRecords` intentionally unchanged (it filters ScorecardEntry by the entry's own `batch_id` — already M:N-correct).
- Leaderboard cohort `getScopedStudentIdSet` (mode-gated). Scoring: `monthly-leaderboard-badge.service` (distinctScopeKeys + finalize cohort), `student-achievement.service` (batchArenaQuestionIdsForStudent).
All use `membershipKeysOr(..., [exact legacy value])`, a `*Resolved` swap, or an explicit `if (mode==='legacy')` branch — **legacy mode is byte-identical** at every site.

**Final adversarial audit (over the complete diff):** content-contest-classes and leaderboard-and-scoring = *sound*. Two real enrollment-mode bugs found & fixed: a student with **0 active enrollments** would have seen ALL assignments (dashboard + assignment.list) — now returns a no-match in non-legacy mode (legacy keeps its batch-less "all published" behavior). The flagged "shape differs across modes" and "assertStudentInBatch _id collision" criticals were verified **false positives** (legacy returns the exact legacy filter; the membership branch returns early before the spread — no collision).

**Admin-display analytics: ✅ wired (mode-gated, legacy verbatim).** `admin.controller` `arenaProgressMapsForStudentRows`, `assignmentProgressMapsForStudentRows`, and `getStudent` now aggregate across the student's active batches in non-legacy mode (distinct-union of questions/assignments). Focused adversarial audit: **sound** — correct dedup (no double-count of shared items), assignment counts solved only when all its questions are accepted, map keys consistent (all string), legacy branches byte-identical.

**Section backfill (closes the transition limitation):** `src/scripts/backfill-enrollment-section-id.js` (dry-run default) stamps `StudentEnrollment.section_id` from the student's legacy section (`section_id || enrollment_section`) so section-scoped rosters work under pure `enrollment` mode. Run it before flipping to pure `enrollment`; `union` mode recovers legacy section matches meanwhile.

**Display-only (intentionally NOT changed — keep `Student.batch_id` primary cache):** announcement label match, studentResponse, admin-content note/announcement audience checks.

## 13. Operational edge-case register (M:N) — 67 found via code-grounded hunt

These surface only once a student is genuinely in 2+ batches, or a batch is created/retired/re-linked. The core architecture handles them at the data level; these are the *operational/policy* tail. Triaged:

### Critical (6)
- **C1 — Two active Courses linked to one batch → duplicate invoices** + `findCourseByBatchId` picks arbitrarily. Fix: enforce *one active Course per batch* (app guard in `createCourse` + optional partial-unique index on `{linked_batch_id, is_active}`), or per-`(student,batch,period)` invoice dedup. *(code/schema/policy)*
- **C2 — Batch created with no linked Course → can't enroll/bill students.** Fix: batch-create UI offers/requires linking a Course; friendly empty-state + error. *(ui/ops)*
- **C3 — Per-enrollment billing = a 2-batch student gets 2 invoices/month.** This is *intended* for distinct paid batches, but the billing model must be explicitly confirmed; only wrong when two Courses share one batch (C1). *(policy)*
- **C4 — Section per batch.** `Student.section_id` is single; `StudentEnrollment.section_id` is per-batch. Announcement & some section-scoped reads still use the single primary section. *(code)*
- **C5 — Primary-batch cache not recomputed on add/remove-batch.** `Student.batch_id`/`batch`/`section_id` go stale vs enrollments (legacy readers, profile, exports). Fix: `recomputePrimaryBatchCache(studentId)` after add/remove/transition. *(code)*
- **C6 — Referral/registration credits consumed per-invoice** → multi-batch burns them faster. Fix: once-per-student-per-month policy (decided) needs implementation. *(policy+code)*

### High themes (~30)
- **Read-switch coverage gaps found:** `mentor-sessions` (`listSlots`/`mySessions` read `student.batch_id` primary only) and `announcement` (section + multi-batch context) — multi-batch students miss non-primary-batch mentor slots / announcements. *(code — completes the read-switch)*
- **Attendance:** `ClassJoinAudit` has no `batch_id` → roster shows the student's *primary* batch label, per-batch attendance reports impossible. Fix: add `batch_id` (+ `enrollment_id`) at join time + backfill. *(code+backfill)*
- **Notifications:** `dedupe_key` omits batch → relink/multi-batch can suppress or duplicate; global broadcast should target distinct students. *(code)*
- **Reporting dedup:** batch `student_count`, scorecard summary, CSV exports count per `(student,batch)` → platform totals over-count; need `DISTINCT(student_id)`. *(code)*
- **Batch lifecycle:** soft-retiring a batch with active enrollments → zombie students still billed; orphaned `Contest`/`ArenaQuestion`/`Announcement` `batch_id`; Course re-link leaves invoices/scorecard on the old batch. *(code+ops)*
- **Two student-move mechanisms** (enrollment_number rename via `syncEnrollmentToBatch` vs additive add/remove-batch) can collide. *(code/ui)*
- **enrollment_number encodes ONE batch** → secondary batches have no roll-number identity; enrollment_number-based reports are primary-only. *(policy)*
- **Mid-cycle billing:** add mid-month (proration?), remove mid-month (already-generated invoice / refund?). *(policy+code)*

### Policy decisions the business must make (not code)
1. Billing: per-enrollment (each batch billed) — confirm — and **proration** on mid-cycle add/remove; refund/credit on removal.
2. Referral/registration credits: once per student per month (decided) vs per-invoice.
3. One active Course per batch? (recommended) or allow several.
4. Multi-batch identity: secondary roll numbers / per-batch sections?
5. Can a student win Student-of-the-Month in multiple batches in the same month?
6. Re-linking a Course's batch: forbid once it has enrollments (recommended) vs. migrate historical invoices/scorecard.

> Full 67-item list with file:line, current behavior, and recommended handling is in the edge-case-hunt workflow output. None of these block the *legacy-mode* deploy (prod unaffected); they gate **enabling multi-batch operation**.

### Resolved in code (this session — flag-gated, legacy byte-identical, adversarially verified)
- **Read-switch completeness gaps closed:** `mentor-sessions` (listSlots/mySessions/joinSession) and `announcement` (programMatches + per-batch section) now use the full membership set + the student's section *in each batch* (resolved via `enrollmentBatchIdsForStudent`). Verified: legacy byte-identical; M:N per-batch-section correct (the verifier's 3 HIGH section-mismatch findings are now fixed).
- **C1** — one-active-Course-per-batch guard in `createCourse`/`updateCourse` (blocks the duplicate-invoice/arbitrary-pick critical; self-edit allowed). *Verdict: sound.*
- **C5** — `recomputePrimaryBatchCache` (fills an empty `Student.batch_id` after add/remove-batch; never overwrites an enrollment_number-owned primary). *Verdict: sound.*
- **Attendance** — `ClassJoinAudit.batch_id` added + stamped at join (the batch attended *as*) + `attended_batch_id` in the roster + `backfill-classjoinaudit-batch-id.js`. *Verdict: sound.*
- **Batch-retire guard** — `remove()` blocks retiring a batch with active members (enrollment **or** legacy) unless `?force=1` → no zombie students. *Verdict: sound.*
- **Section backfill** — `backfill-enrollment-section-id.js` (per-enrollment section for pure `enrollment` mode).

### Inspected — no backend change needed
- **Notifications:** dedupe key is `slot._id`+`student._id`; slots are single-batch → one notification per slot (no dup; relink dup was speculative).
- **Reporting/scorecard:** per-batch counts/entries are correct under M:N; platform totals use `Student.countDocuments` (distinct). Only a frontend note: don't *sum* per-batch counts for a platform total.

### Product decisions — MADE (2026-06-04) and IMPLEMENTED + verified
- Billing **per-batch (separate invoice each)**; mid-month join **charges full month** (no proration); mid-month leave **auto-cancels the unpaid (pending) invoice** for that batch (paid months kept); **no auto-refund**.
- Referral/joining credits: **once per student per month** (rarely used → not yet coded; low priority).
- **Exactly one active course per batch** (guard in create/update course). Course = a batch's billing/fees record.
- **No sections** for now → per-batch-section work is moot (code inert).
- Student **can win Student-of-the-Month in multiple batches** + appears on each batch's leaderboard.
- **Course re-link forbidden after enrollment** (guard in updateCourse).
- **Per-batch roll numbers (auto-generated, #7b):** `StudentEnrollment.roll_number` (prefix+YY+4-digit seq, unique per batch) auto-assigned on add-batch with collision-retry; primary roll = `Student.enrollment_number` (display fallback + backfill `backfill-enrollment-roll-number.js`). *Adversarial verdict: sound.*
- Batch-retire blocked with active members (force override). Scholarship per batch; one notification per item; portal one-batch-at-a-time. (all done/confirmed)

### Built — admin multi-batch UI (this session, role-aware, lint-clean)
- Student detail ([StudentDetailCard.jsx](my-codemasti-admin/src/components/students/StudentDetailCard.jsx)) now has a **Batches** panel: lists each active batch + its per-batch roll number. **admin/super_admin** get **Add to batch** (auto-roll) + **Remove** (confirms the unpaid-invoice cancellation). **Instructors** see it **read-only** (scoped to their batches); **mentors** aren't on the students page.
- `GET /admin/students/:id` returns `batches[]` (batch + roll only — academic, safe for instructors).
- Wiring in [StudentsPage.jsx](my-codemasti-admin/src/pages/StudentsPage.jsx) (`POST/DELETE /admin/students/:id/batches` + refetch); gated by the existing `canManageStudents` (admin/super_admin).
- Courses page relabeled so staff read it as **a batch's fees** (one active course per batch).

### Referral once-per-month — DONE
`invoice-generator.service.js`: global per-student credits (referral fee credit + one-time registration discount) apply **only on the student's PRIMARY batch invoice** (`course.linked_batch_id === Student.batch_id`). Non-primary invoices get base fee + scholarship only → a multi-batch student consumes a credit once per calendar month, not once per batch. (Multi-month credits still span months, one month at a time, by design.)

### Per-batch XP — DONE
Decision: a student's leaderboard XP is limited to **that batch's own content** (arena questions / assignments tagged to the batch, plus globally-untagged content which is shown to every batch). Implemented in `leaderboard.controller.js` via an opt-in `buildRowsForSubmittedFilter(t, { batchIds })` that filters the arena/assignment pipelines on the looked-up question/assignment `batch_id`/`batch_ids`. Threaded through from `getScopedStudentIdSet` (returns `{ ids, batchIds }`) and into the monthly "Student of the Month" badge (`monthly-leaderboard-badge.service.js`, scoped to the cohort's batch).
- **Gated to non-legacy** — legacy mode passes no `batchIds` → global XP, byte-identical.
- **Lifetime/milestone badges stay global** (`badge-program.service.js` still calls the unscoped form) — a "reach N XP" achievement is a whole-journey metric, not per batch.
- **Per-batch switcher — BUILT.** `/leaderboard` + `/leaderboard/me` accept `batch_id` (validated ∈ the student's batches; default = primary). One board = one batch (cohort + XP both scoped). `me` returns `{ selected_batch_id, batches[] }`. The portal leaderboard renders a batch `<select>` for multi-batch students (keyed into the React Query key so a change reloads from the server), threading `batch_id` to the leaderboard, my-XP, and the local fresh-XP floor (scoped client-side via each assignment group's `batch_id`).
- **Monthly "Student of the Month" is batch-aware too** (`monthly-leaderboard-badge.controller.js` honors a validated `batch_id`; the portal query is keyed on the selected batch). This was the stale-on-switch spot.
- Validated read-only against the dev DB: e.g. I260189 → Innovators 180 XP (rank 5/9), Spark 46 XP (rank 1/1), default = primary (Innovators).

### apiStrict fix — DONE
`serverApi.strict:true` ([db.js](my-codemasti-server/src/config/db.js)) bans the `distinct` command. Replaced all four `.distinct()` calls (2 in the new cohort helpers, 2 pre-existing in monthly-badge + admin arena count) with `find().select().lean()` + app-code dedupe. Surfaced only in non-legacy mode (leaderboard 500s); would have hit prod on flag-flip.

### Mentors & doubts — audited + fixed for M:N
- **Mentor sessions** (server `mentor-sessions.controller.js`): already M:N-correct — `listSlots`/`mySessions`/`joinSession` use `scopeStudentToBatch` + `membershipKeysOr` + per-batch `sectionResolverFor` + `batchSectionClausesFor`; `joinSession` validates against the resolved batch set and per-batch section. Follows the header-selected batch (validated against active enrollments). `book`/`cancel` gate by slot state/owner.
- **Community doubts**: channel = the student's **effective** batch (`student.batch_id` after `scopeStudentToBatch` = the header-selected batch). Correct under M:N.
- **Personal doubts (student)**: per-student (no batch field) — student sees all their own. Subjects come from the selected batch.
- **FIX — staff-side personal doubts** (`staff-doubts.controller.js listPersonal`): was scoping by the **legacy single `Student.batch_id`**, so a multi-batch student was invisible to their non-primary batch's staff. Now mode-gated: legacy unchanged (byte-identical); non-legacy uses the M:N cohort (`studentIdsInBatches`), so a multi-batch student's doubts surface to every batch they're **actively** enrolled in. Validated: Ritesh (I260189) now appears under both Spark and Innovators in enrollment mode, Spark-only under legacy.
- **Frontend**: both portal (`/mentor-sessions`, `/doubts` ride the `request()` auto batch_id injection → follow header) and admin (`StaffDoubtsPage` batch tabs scoped per staff role; `AdminMentorSlotsPage` super_admin/admin only) need no change.
- Open option (not a bug): `PersonalDoubt` has no `batch_id`, so a multi-batch student's doubt surfaces to all their batches' staff and the row shows their primary batch. Add `batch_id` to `PersonalDoubt` (stamped from the effective batch at creation) if you want doubts routed to one specific batch.

### Nothing left to build
All policy decisions implemented. (Pre-existing, unrelated: a dead `getXpHighlightClass` in StudentsPage trips lint — not introduced here.)

## Appendix A — Source map of load-bearing files

- Identity / membership: `models/Student.js`, `models/StudentEnrollment.js`, `models/BatchCatalog.js`, `models/Course.js`, `utils/enrollment.js`, `utils/student-batch-context.js`, `constants/batchDefaults.js`, `services/enrollment-sync.service.js`
- Billing (M:N-safe today): `models/{Invoice,Payment,ManualPayment,Refund}.js`, `services/{invoice-generator,invoice-discount,monthly-invoice.scheduler,phonepe-gateway}.service.js`
- Scoping / staff: `utils/{instructorBatchScope,assignmentBatchFilter,rbac}.js`, `models/Staff.js`
- Content: `models/{Assignment,ArenaQuestion,Note,LiveClass,MentorSlot,Contest,Announcement,TimetableSlot,TimetableEvent,ScorecardEntry,ScorecardTest,MonthlyLeaderboardBadge,CommunityMessage}.js`
- Frontends: `my-codemasti-com/lib/{selected-course-context,auth-client}.ts`, `my-codemasti-admin/src/pages/batches/batchConstants.js`

## Appendix B — Why reuse-enrollment over the alternatives (decision record)

- **Reuse-enrollment (chosen):** membership and money live on **one graph** — "who's in batch X," "who to bill," and "whose scholarship to look up" are the same query. Smallest schema surface (one indexed field), lowest steady-state drift, leverages already-backfilled data. Its risks (empty-set at switch; gap-fill billing) are real but fully mitigated by union-mode + the billing dry-run gate.
- **Junction collection (rejected):** a second membership graph parallel to enrollments → academic vs billed membership can diverge → revenue leak on paid second batches. More new code, more drift surface, same aggregation fixes.
- **Embedded `batch_ids[]` (rejected as authoritative):** fastest reads but a *third* denormalized field to keep in sync with enrollments; its backfill unions in enrollment-number/legacy batches that have no enrollment → same academic/billing mismatch. We borrow only its best idea — the never-empty primary mirror.
