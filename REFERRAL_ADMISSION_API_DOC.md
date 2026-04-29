# Referral Admission API (External Admin Integration)

This document defines the single API that marks referral as counted when admission is completed from any external system (main website admin portal, CRM, or internal ops tool).

## Purpose

When a student admission is finalized, call this API with `referral_code` (if available).  
If the code is valid, backend automatically:

- links the student to the referrer (`referred_by`)
- applies referee registration discount
- updates referral count for referrer
- creates referral events
- queues referral rewards/benefits

No separate "mark referral done" endpoint is required.

---

## Endpoint

- **Method:** `POST`
- **URL:** `/v1/admin/students`
- **Auth:** Staff JWT (Bearer token)

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
- `enrollment_number` (string, format `I|S|B + 6 digits`, example `I260105`)
- `enrollment_date` (ISO date)
- `school_name` (string, min 1)
- `whatsapp_number` (string, min 6)
- `cst_registration_id` (string, min 1)

### Optional fields

- `school_class` (number, 5 to 10)
- `student_phone` (string)
- `referral_code` (string, example `CM-d9f7962f`)

> To mark referral automatically, include `referral_code` in this request.

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

Example shape:

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
    "registration_fee_discount_percent": 10,
    "referral_applied": true
  },
  "message": "Student created"
}
```

## Confirmation Rules

Treat referral as successfully counted only when:

- `success === true`
- `data.referral_applied === true`

Optional additional check:

- `data.registration_fee_discount_percent > 0`

---

## Error Cases

### Invalid referral code

- HTTP `400`
- `error.code = "INVALID_REFERRAL_CODE"`

### Duplicate email

- HTTP `409`
- `error.code = "EMAIL_ALREADY_EXISTS"`

### Duplicate enrollment number

- HTTP `409`
- `error.code = "ENROLLMENT_ALREADY_EXISTS"`

---

## Recommended External Flow

1. Main registration page captures `ref` from URL query and stores it as `referral_code`.
2. External admin marks admission done.
3. External system calls `POST /v1/admin/students` with that same `referral_code`.
4. Use response `data.referral_applied` as final status in external portal.

---

## Student Portal Tracking (already available)

After successful referral admission:

- `GET /v1/referral/me` shows updated totals and link/code data.
- `GET /v1/referral/events` shows referral event history.

So no extra tracking API is required for portal display.
