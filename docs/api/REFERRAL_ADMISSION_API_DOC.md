# Referral Admission API (External Admin Integration)

This document defines the single API that marks a referral as counted when an admission is completed from any external system (main website admin portal, CRM, or internal ops tool). It is the generic "create student" endpoint; referral handling is triggered by the optional `referral_code`.

Source of truth: `src/controllers/admin.controller.js` (`createStudent`), `src/routes/modules/admin.routes.js`, `src/utils/referralRewards.js`, `src/utils/enrollment.js`. Route table: [ROUTES.md](ROUTES.md).

## Purpose

When a student admission is finalized, call this API with `referral_code` (if available).
If the code is valid, the backend automatically:

- links the student to the referrer (`referred_by`)
- applies the referee registration discount (10%, stored on the new student)
- recounts the referrer's successful referrals (`Student.countDocuments({ referred_by })`)
- creates `ReferralEvent` rows (`referral_admission` for the referrer, `joined_with_referral` for the new student)
- queues referral rewards on the referrer (`referral_benefits_queue`) and sends a notification

No separate "mark referral done" endpoint is required.

---

## Endpoint

- **Method:** `POST`
- **URL:** `/v1/admin/students`
- **Auth:** Staff JWT (Bearer token) with role **`super_admin` or `admin`**. `instructor` and `mentor` get `403 FORBIDDEN`; a student token gets `401`. (Billing-only routes are super_admin only; this route is not.)

## Headers

```http
Authorization: Bearer <staff_jwt>
Content-Type: application/json
```

## Request Body

### Required fields

- `email` (string, valid email)
- `name` (string, min 2)
- `parent_name` (string, min 2)
- `phone_number` (string, min 6)
- `enrollment_number` (string, **batch prefix (one or more letters) + 6 digits**, regex `^[A-Za-z]+\d{6}$`, example `I260105` or `SU260206`). The six digits are `YY` + 2-digit section + 2-digit roll. The prefix is upper-cased and must match a batch in the catalog (`BatchCatalog.enrollment_prefix`; the built-in prefixes are `S` Spark, `B` Builders, `I` Innovators). An unknown prefix returns `400 INVALID_ENROLLMENT_NUMBER`.
- `enrollment_date` (ISO date)
- `school_name` (string, 1-200)
- `whatsapp_number` (string, 6-30)
- `cst_registration_id` (string, 1-80)

### Optional fields

- `school_class` (integer, 5 to 10)
- `student_phone` (string, max 30; defaults to `""`)
- `referral_code` (string, example `CM-d9f7962f`; matched case-insensitively against `Student.referral_code`)

> To mark the referral automatically, include `referral_code` in this request.

To preview the next free enrollment number for a batch/section use `GET /v1/admin/students/next-enrollment?batch_id=&section_id=` (super_admin/admin).

## Example Request

```json
{
  "email": "newstudent@example.com",
  "name": "Aarav Singh",
  "parent_name": "Rahul Singh",
  "phone_number": "9876543210",
  "enrollment_number": "I260105",
  "enrollment_date": "2026-04-29T00:00:00.000Z",
  "school_class": 8,
  "school_name": "DPS",
  "student_phone": "",
  "whatsapp_number": "9876543210",
  "cst_registration_id": "CST-2026-00123",
  "referral_code": "CM-d9f7962f"
}
```

---

## Success Response (200)

```json
{
  "success": true,
  "data": {
    "id": "6810f7...",
    "email": "newstudent@example.com",
    "name": "Aarav Singh",
    "batch": "Innovators",
    "batch_id": "innovators",
    "enrollment_number": "I260105",
    "enrollment_batch_prefix": "I",
    "enrollment_batch_name": "Innovators",
    "enrollment_year": 2026,
    "enrollment_section": "01",
    "enrollment_roll_no": "05",
    "school_class": 8,
    "avatar_url": "",
    "registration_fee_discount_percent": 10,
    "referral_applied": true
  },
  "message": "Student created",
  "meta": {
    "enrollment_sync": {
      "changed": true,
      "action": "created",
      "new_course": { "id": "...", "code": "innovators", "name": "Innovators" },
      "new_enrollment_id": "..."
    }
  }
}
```

`meta.enrollment_sync` reports the automatic `StudentEnrollment` creation for the student's batch (so billing picks the student up). It is best-effort and never fails the request. Typical `action` values for a new student: `created`, `skipped_no_target_course` (no active course linked to the batch; `detail` explains) or `error` (`error` holds the message). When an enrollment was created, its per-batch `roll_number` is set to the student's `enrollment_number` (this is the primary roll; secondary batches added later get auto-generated rolls such as `B260012`, stored on `StudentEnrollment.roll_number`).

## Confirmation Rules

Treat the referral as successfully counted only when:

- `success === true`
- `data.referral_applied === true`

Optional additional check:

- `data.registration_fee_discount_percent > 0`

---

## Referral rewards applied

Referee (new student): `registration_fee_discount_percent = 10`. It is consumed on the student's first invoice, only on their primary-batch invoice, then set back to 0.

Referrer: for every successful admission, entries are appended to `referral_benefits_queue` (`src/utils/referralRewards.js`):

| Trigger | Entry |
|---|---|
| each successful referral | `PER_REFERRAL_NEXT_MONTH`: +30% monthly fee discount for 1 month |
| total reaches 2 | `MILESTONE_2`: 70% for 1 month |
| total reaches 3 | `MILESTONE_3`: 100% for 1 month |
| total reaches 5 | `MILESTONE_5`: 100% for 2 months, plus `MILESTONE_5_MERCH` (merchandise, no fee effect) |
| total 7, 9, 11, ... | `MILESTONE_EXT`: 100% for 1 more month |

**Once-per-month credit rule** (`src/services/invoice-generator.service.js`, `invoice-discount.service.js`): when an invoice is generated, at most **one** queue item of type `fee_credit` is consumed, its `months` is decremented by 1 (item removed at 0), and this happens **only on the invoice of the student's primary batch** (`course.linked_batch_id === Student.batch_id`). Invoices for the student's other batches carry no referral credit. So a multi-batch student burns one credit-month per billing run, and a multi-month credit spans consecutive months. This is enforced by the primary-batch gate and per-invoice consumption, not by a per-calendar-month counter, so manually generating an extra invoice for the primary batch would consume another credit.

---

## Error Cases

### Not authorized
- HTTP `401` (missing/invalid token) or `403 FORBIDDEN` (staff role is not `super_admin`/`admin`)

### Validation failure
- HTTP `400`, `error.code = "VALIDATION_ERROR"` (Zod issues in `error.details`), e.g. malformed `enrollment_number`

### Invalid enrollment number / unknown batch prefix
- HTTP `400`
- `error.code = "INVALID_ENROLLMENT_NUMBER"`

### Invalid referral code
- HTTP `400`
- `error.code = "INVALID_REFERRAL_CODE"` (no student created)

### Duplicate email
- HTTP `409`
- `error.code = "EMAIL_ALREADY_EXISTS"`

### Duplicate enrollment number
- HTTP `409`
- `error.code = "ENROLLMENT_ALREADY_EXISTS"`

---

## Recommended External Flow

1. Main registration page captures `ref` from the URL query and stores it as `referral_code`.
2. External admin marks admission done.
3. External system calls `POST /v1/admin/students` with that same `referral_code`, using a staff account with the `admin` or `super_admin` role.
4. Use response `data.referral_applied` as the final status in the external portal.

An existing student who joins another batch is **not** created again: look them up with `GET /v1/admin/students/lookup?email=` and use `POST /v1/admin/students/:id/batches` (see [../batches-and-enrollment.md](../batches-and-enrollment.md)).

---

## Student Portal Tracking (already available)

After a successful referral admission:

- `GET /v1/referral/me` shows updated totals and link/code data.
- `GET /v1/referral/events` shows referral event history.

Both require a student bearer token. No extra tracking API is required for portal display.
