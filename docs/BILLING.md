# Billing

Money is stored in **paise** (integers). All billing admin routes are **super_admin only** (`src/routes/modules/admin-billing.routes.js`); student routes are in `student-billing.routes.js`. Route table: [api/ROUTES.md](api/ROUTES.md).

## Models (`src/models`)

| Model | Key fields | Notes |
|---|---|---|
| `Course` | `code` (unique), `base_fee_paise`, `billing_mode` (`monthly`\|`upfront`), `linked_batch_id`, `is_active` | A course is a batch's fee record; one active course per batch is enforced in `admin-courses.controller.js` (`BATCH_HAS_ACTIVE_COURSE`). Creating a batch auto-creates a fee-0 placeholder course. |
| `StudentEnrollment` | `student_id`, `course_id`, `status` (`active`\|`completed`\|`cancelled`), `fee_override_paise`, `batch_id`, `roll_number` | One invoice stream per enrollment. Partial-unique `{student_id, course_id}` for active/completed. See [batches-and-enrollment.md](batches-and-enrollment.md). |
| `Invoice` | `invoice_number` (`INV-YYYY-MM-XXXXXX`, unique), `enrollment_id`, `course_id`, `period_start/end/label`, `subtotal_paise`, `*_discount_paise` (scholarship, student_of_month, referral, registration), `manual_adjustment_paise`, `total_due_paise`, `status`, `refunded_paise` | Statuses: `pending`, `paid`, `failed`, `refunded`, `partially_refunded`, `cancelled`. |
| `Payment` | `invoice_id`, `merchant_transaction_id` (unique), `phonepe_transaction_id`, `status`, `payment_method`, `webhook_payload`, `refunded_paise` | Statuses: `initiated`, `pending`, `success`, `failed`, `refunded`, `partially_refunded`. One row per attempt; approved manual proofs also create one (`MANUAL-<id>`). |
| `ManualPayment` | `invoice_id`, `payee_vpa`, `utr_reference`, `screenshot_url`, `status` (`submitted`\|`approved`\|`rejected`), `review_note`, `payment_id` | Student-submitted UPI proof awaiting review. |
| `Refund` | `payment_id`, `invoice_id`, `amount_paise`, `merchant_refund_id` (unique), `status` (`initiated`\|`pending`\|`success`\|`failed`) | PhonePe refunds only. |

## Modes: `PAYMENTS_MODE`

`src/utils/paymentsConfig.js`: `manual_upi` (default; any value other than `phonepe`) or `phonepe`. `GET /v1/students/payments/config` returns `{ mode, upi? }` (UPI payee included only in manual mode) so the portal picks the UI. The server does **not** reject `POST /students/payments/initiate` when the mode is `manual_upi`; it simply fails (`GATEWAY_ERROR`) if PhonePe credentials are missing.

## Manual UPI flow (default)

1. Invoice exists with `status: pending`.
2. Student pays to the payee from `UPI_PAYEE_VPA` / `UPI_PAYEE_NAME`, then `POST /v1/students/payments/manual` (multipart: `screenshot` image, `invoice_id`, optional `utr_reference`). Needs Cloudinary (503 `CLOUDINARY_NOT_CONFIGURED` otherwise). Rejected with 409 if the invoice is not `pending` or a proof is already `submitted`.
3. A `ManualPayment` is created as `submitted`. The invoice is **not** marked paid.
4. A super_admin checks the actual bank credit, then `POST /v1/admin/manual-payments/:id/approve` (creates a successful `Payment` with `merchant_transaction_id = MANUAL-<id>`, sets invoice `paid`) or `.../reject`. `PATCH /v1/admin/manual-payments/:id` edits the note after review. Re-reviewing returns 409 `ALREADY_REVIEWED`.

## PhonePe flow (Standard Checkout v2, `src/services/phonepe-gateway.service.js`)

Auth is OAuth (`client_id` / `client_secret` / `client_version`, token cached with a 60 s safety margin); API calls use `Authorization: O-Bearer <token>`. `PHONEPE_SANDBOX` (default `true`) selects `api-preprod.phonepe.com/apis/pg-sandbox` vs production `api.phonepe.com/apis/{identity-manager,pg}`.

1. `POST /v1/students/payments/initiate {invoice_id}` (invoice must be the student's, `pending`, with `total_due_paise > 0`): creates a `Payment` (`initiated`, id `INV<last8><ts><rnd>` upper-cased, a new id per attempt), calls `POST /checkout/v2/pay` (`expireAfter` 1200 s, redirect `PHONEPE_REDIRECT_URL_BASE?merchantTransactionId=...`), sets the payment to `pending` and returns `redirect_url`. Gateway failure marks the payment `failed` and returns 502.
2. Student pays on PhonePe's hosted page and returns to the portal.
3. **Webhook** `POST /v1/payments/webhook/phonepe` (raw body; mounted ahead of the JSON parser in `src/app.js`) and/or **status poll** `GET /v1/students/payments/status/:merchantTxnId` (calls `/checkout/v2/order/:id/status` while the payment is not final) both converge on: payment `success`/`failed` + `completed_at`; on `success` the invoice becomes `paid` (`paid_at`, `paid_payment_id`).
4. State mapping: PhonePe `COMPLETED` -> `success`, `FAILED` -> `failed`, anything else -> `pending`.

### Webhook (`controllers/payments-webhook.controller.js`)
- Auth: `Authorization` header must equal lowercase `sha256("<PHONEPE_WEBHOOK_USERNAME>:<PHONEPE_WEBHOOK_PASSWORD>")`. Mismatch -> 401 and log `PHONEPE_WEBHOOK_SIG_FAIL`. **If either variable is unset the check is skipped** (one-time warning).
- Routing is by `payload.event`: anything starting `pg.refund.` is a refund event (`merchantRefundId`); everything else is treated as a payment event keyed by `payload.merchantOrderId` (documented events: `checkout.order.completed`, `checkout.order.failed`; refunds `pg.refund.accepted|completed|failed`).
- Unknown order/refund id -> logged and answered 200 `{ignored:true}` so PhonePe stops retrying. Non-JSON body -> 400.
- Idempotent: if the stored status already equals the new one and a webhook was recorded, it only refreshes the payload (`{duplicate:true}`).
- Refund `failed`: reverts the optimistic `refunded_paise` on payment and invoice and restores statuses.

## Refunds (`POST /v1/admin/payments/:id/refund`, super_admin)

Body: optional `amount_paise` (default: remaining), `reason`. Only `success` / `partially_refunded` payments; amount must be `0 < amount <= amount_paise - refunded_paise`. Creates a `Refund` (`RF<last8><ts><rnd>`), calls `POST /payments/v2/refund`, then **optimistically** sets `refund.status=pending`, increments `payment.refunded_paise` / `invoice.refunded_paise` and moves statuses to `refunded` / `partially_refunded`; the webhook confirms or rolls back. Gateway error -> refund `failed`, 502. The refund call uses the payment's original `merchant_transaction_id` and there is no guard for manual payments (`MANUAL-<id>`); no manual-UPI refund path exists in code, and a refund attempt on such a payment is expected to fail at the gateway (unverified). `GET /v1/admin/refunds` lists the latest 500.

## Invoice generation (`src/services/invoice-generator.service.js`)

`buildInvoiceForPeriod({enrollmentId, periodStart, periodEnd, dueDate, generatedBy})` (requires an `active` enrollment):

- Subtotal = `enrollment.fee_override_paise` if set, else `course.base_fee_paise`.
- Discounts (`invoice-discount.service.js`), applied in this order, all in whole-rupee rounding for percentages:
  1. Registration discount (`Student.registration_fee_discount_percent`, only on the enrollment's first invoice, then zeroed). Referees get 10% (`REFEREE_REGISTRATION_DISCOUNT_PERCENT`).
  2. Referral fee credit: one item from `Student.referral_benefits_queue` (`reward_type: fee_credit`); its `months` is decremented per use and removed at 0.
  3. Scholarship: latest `ScorecardEntry` in the course's linked batch whose `exam_date` falls in the **previous calendar month** (amount or percent); none -> no scholarship.
  4. Student of the Month: +5% when the student holds the previous month's `MonthlyLeaderboardBadge` in that batch.
  5. Merit cap: scholarship + SotM are trimmed (SotM first) so they never exceed what remains after registration and referral.
  6. `manual_adjustment_paise` is added later by `PATCH /v1/admin/invoices/:id`, not at generation.
- **Registration discount and referral credit apply only on the invoice of the student's primary batch** (`course.linked_batch_id === Student.batch_id`), so a multi-batch student consumes each credit at most once per billing run, not once per batch. This is the "once per month" referral rule: it is enforced by the primary-batch gate plus one-credit-per-invoice consumption, not by a per-month counter.
- Credit consumption and invoice creation run in one Mongo transaction (needs a replica set).
- Manual paths: `POST /v1/admin/invoices` (one enrollment + period), `POST /v1/admin/invoices/bulk-generate` (all active enrollments of a course), both accept `due_date`.

### Monthly scheduler (`monthly-invoice.scheduler.js`)

Hourly in-process (and on every cron call). On **UTC day 1** it loads active courses with `billing_mode: monthly` and `base_fee_paise > 0`, finds active enrollments, skips those with an invoice whose `period_start` is in the current UTC month, and builds the rest (`generated_by: "system_cron"`, no due date). Toggle the in-process timer with `BILLING_INVOICE_SCHEDULER=0`; the cron endpoint still runs it. De-dupe is a query plus an in-transaction re-check after locking the enrollment document (`INVOICE_ALREADY_EXISTS` is treated as a skip), not a unique index (see [RUNBOOK.md](RUNBOOK.md) open items). `upfront` courses are never auto-invoiced.

### Side effects of enrollment changes
- Removing a student from a batch completes the enrollment and **cancels its `pending` invoices** (`enrollment-sync.service.js`); paid invoices are kept; no automatic refund.
- There is no proration logic: a mid-month joiner is invoiced by the next UTC day-1 run, or earlier if an admin generates an invoice manually.

## Admin tooling (super_admin)
`/v1/admin/courses`, `/enrollments` (+ `/reconcile`, `/:id/transition`), `/invoices`, `/payments` (+ `/config`, `/reconciliation?period=YYYY-MM`, `/:id/refund`), `/refunds`, `/manual-payments`.
