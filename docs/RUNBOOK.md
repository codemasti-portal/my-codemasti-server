# Runbook

Operational reference for the API. Architecture context: [ARCHITECTURE.md](ARCHITECTURE.md). Deploy steps: [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Schedulers

Two trigger paths exist for the same tick functions:
- **In-process timers** (`src/server.js`): only on the long-running runtime (Docker/EC2, local `npm run dev`). They start after the DB connects.
- **Cron endpoint** `GET|POST /v1/internal/cron/run` (`src/services/cron-runner.js`): the only path on Vercel; also usable on EC2.

Every tick is written to be safe to run late or twice: it claims work with an atomic `updateOne({ <field>_sent_at: null }, { $set: { <field>_sent_at: now } })` and only sends when `modifiedCount === 1`; on a send failure the field is reset to `null` so the next tick retries.

| Name (cron result key) | File | Cadence | Idempotency mechanism | In-process (EC2) | Via cron endpoint | Env toggles |
|---|---|---|---|---|---|---|
| Class reminders (`classReminders`) | `services/timetable-class-reminder.scheduler.js` | 60 s + once at boot | `TimetableSlot`: `instructor_reminder_60m_sent_at`, `student_reminder_10m_sent_at`, `class_live_sent_at`, `meet_link_missing_10m_alert_sent_at` | `startTimetableClassReminderScheduler` | `runReminderTick` | none |
| Mentor reminders (`mentorReminders`) | `services/mentor-reminder.scheduler.js` | 60 s + boot | `MentorSlot`: `reminder_60m_sent_at`, `reminder_15m_sent_at`, `meet_link_missing_alert_15m_sent_at` | `startMentorReminderScheduler` | `runReminderTick` | none |
| Mentor publish sweep (`mentorPublishSweep`) | `services/mentor-notification.service.js` (`runMentorPublishSweepTick`) | 60 s + boot (a bare `setInterval` in `server.js`) | `MentorSlot.publish_notified_at`; max 100 slots per tick; slots published more than 48 h ago are stamped without notifying | `server.js` | `runMentorPublishSweepTick` | none |
| Event reminders (`eventReminders`) | `services/timetable-event-reminder.scheduler.js` | 60 s + boot | `TimetableEvent.reminder_15m_sent_at` | `startEventReminderScheduler` | `runEventReminderTick` | none |
| Assignment release notifications (`assignmentReleaseNotifications`) | `services/assignment-release-notification.scheduler.js` | 60 s + boot | `Assignment.release_notification_sent_at`; a backfill stamps already-released assignments first so deploys do not blast old items; max 80 candidates / 40 notified per tick | `startAssignmentReleaseNotificationScheduler` | `backfillReleaseNotificationFlag` then `runTick` | `ASSIGNMENT_RELEASE_NOTIFY_SCHEDULER=0` disables the in-process timer only |
| Monthly invoices (`monthlyInvoices`) | `services/monthly-invoice.scheduler.js` | hourly + boot (EC2); every cron call | Gate: acts only when `getUTCDate() === 1`. De-dupe: skips enrollments that already have an `Invoice` in the period, and `buildInvoiceForPeriod` re-checks inside its transaction after locking the enrollment document (so concurrent callers serialize); there is still **no unique index** | `startMonthlyInvoiceScheduler` | `runMonthlyInvoiceTick` | `BILLING_INVOICE_SCHEDULER=0` disables the in-process timer only |
| Post-session tasks (`postSessionTasks`) | `services/post-session-tasks.scheduler.js` | cron only (7-day lookback) | `TimetableSlot.post_class_tasks_sent_at`, `MentorSlot.post_session_tasks_sent_at`; claim is rolled back if no recipient resolves | **not started by `server.js`** | `runPostSessionTasksTick` | `POST_SESSION_TASKS_START_AT` (unset/malformed => returns `disabled:<reason>`) |
| Notification cleanup | `services/notification-cleanup.scheduler.js` | 24 h + boot | Age-based `deleteMany` (naturally idempotent) | `startNotificationCleanupScheduler` | **excluded** (would delete every minute) | `STUDENT_NOTIF_DELETE_READ_AFTER_DAYS` (30), `STUDENT_NOTIF_DELETE_UNREAD_AFTER_DAYS` (120), `STAFF_NOTIF_DELETE_AFTER_DAYS` (180) |

Consequences:
- **Vercel**: nothing runs without a pinger; notification cleanup never runs.
- **EC2 without a pinger**: everything except post-session tasks runs. Add the pinger if you rely on post-session tasks.
- **EC2 with a pinger** (both paths): safe for claim-based ticks. For monthly invoices on UTC day 1 the hourly timer and the per-minute cron could execute at the same moment; because duplicate prevention is a non-atomic check, a rare duplicate invoice is possible (open item, see section 9).

### Cron endpoint

```bash
curl -fsS -H "x-cron-secret: $CRON_SECRET" "https://<api-host>/v1/internal/cron/run"
# alt: ?key=$CRON_SECRET (ends up in access logs), POST works too
```
Response: `{ success: true, data: { ran_at, results: { classReminders: "ok", ..., postSessionTasks: "ok" | "disabled:missing" | "error: ..." } } }`. Each tick is in its own try/catch; one failure does not stop the others. `401 UNAUTHORIZED` = wrong/missing secret; `503 CRON_NOT_CONFIGURED` = `CRON_SECRET` unset. The pinger should call it every minute (the 60 s ticks assume that).

## 2. Rate limiting

| Limiter | Scope | Limit | Where |
|---|---|---|---|
| `apiLimiter` | everything after the PhonePe webhook (incl. `/health`, cron) | 200 req/min/IP (`RATE_LIMIT_API_MAX`) | `src/app.js`, `middlewares/rateLimit.middleware.js` |
| `otpLimiter` | `/v1/auth/otp/*`, `/v1/staff-auth/otp/*` | 5 req/min/IP | `src/app.js` |

`express-rate-limit` replies 429 with standard `RateLimit-*` headers. State is in memory per process/instance. Behind Nginx `TRUST_PROXY=1` must be set or every client shares the proxy IP (and the limit). Students on one school/lab IP share the 200/min budget.

## 3. Health checks

`GET /health` (liveness + DB-connect attempt), `GET /health/db` (Mongo `ping`). Both pass through the lazy DB-connect middleware, so a DB outage shows as 503 on both. Docker `HEALTHCHECK` uses `/health`.

```bash
curl -s localhost:5001/health/db                      # on the EC2 host
sudo docker logs --tail 200 -f codemasti-api          # container logs
sudo docker inspect --format '{{.State.Health.Status}}' codemasti-api
```

## 4. Log contexts to grep

Errors are single-line `[ERROR] {json}` (every `sendError`, 4xx included, logs `"context":"API_ERROR"` with `statusCode`; filter `"statusCode":5` for server faults).

| Context / tag | Meaning |
|---|---|
| `DB_CONFIG` | `MONGODB_URI` missing |
| `DB_CONNECT_ALL_ATTEMPTS_FAILED`, `DB_CONNECT_ON_REQUEST` | Mongo unreachable at boot / on a request (client sees 503 `DB_NOT_CONNECTED`) |
| `HEALTH_DB_NOT_READY`, `HEALTH_DB_PING_FAILED` | `/health/db` failures |
| `SERVER_BOOTSTRAP`, `UNCAUGHT_EXCEPTION` | Process exits (exit code 1) |
| `UNHANDLED_REJECTION` | Logged, process continues |
| `AUTH_REFRESH_TOKEN_VERIFY`, `STAFF_AUTH_REFRESH_TOKEN_VERIFY` | Bad refresh tokens |
| `PHONEPE_WEBHOOK_SIG_FAIL` | Webhook `Authorization` mismatch (401) |
| `PHONEPE_WEBHOOK_CONFIRM_FAIL` | Webhook credentials unset and the PhonePe status call failed (webhook answered 503, PhonePe retries) |
| `PHONEPE_WEBHOOK_CONFIRM_MISMATCH` | Webhook credentials unset and PhonePe's status disagrees with the webhook (answered 409, nothing changed): possible forged request |
| `[SECURITY]` (startup) | No CORS origins configured in production; or `PAYMENTS_MODE=phonepe` without webhook credentials |
| `PHONEPE_WEBHOOK_DECODE_FAIL` | Webhook body is not JSON (400) |
| `PHONEPE_WEBHOOK_UNKNOWN_ID`, `PHONEPE_WEBHOOK_UNKNOWN_REFUND` | Webhook for an id we do not know (acked 200 `ignored`) |
| `PAYMENT_STATUS_VERIFY_FAIL` | PhonePe status poll failed |
| `[OTP_DEBUG]`, `[STAFF_OTP_DEBUG]` | `OTP email send failed: <reason>` is always logged. The line `OTP for <email>: <otp>` is printed only if `OTP_DEBUG_LOG=true`, or `NODE_ENV!=production` and `OTP_DEBUG_LOG!=false` |
| `[MONTHLY_INVOICE_GENERATE_FAILED]`, `[MONTHLY_INVOICE_TICK_FAILED]`, `[MONTHLY_INVOICE_BOOT_TICK_FAILED]` | Billing scheduler |
| `[TIMETABLE_CLASS_REMINDER_TICK_FAILED]`, `[MENTOR_REMINDER_TICK_FAILED]`, `[EVENT_REMINDER_TICK_FAILED]`, `[MENTOR_PUBLISH_SWEEP_TICK_FAILED]`, `[ASSIGNMENT_RELEASE_NOTIFY_TICK]` | Reminder ticks |
| `[TIMETABLE_POST_CLASS_TASKS]`, `[MENTOR_POST_SESSION_TASKS]`, `[POST_SESSION_TASKS] Disabled` | Post-session tasks |
| `[NOTIFICATION_CLEANUP]`, `[NOTIFICATION_CLEANUP_FAILED]` | Retention job |
| `[BATCH_REGISTRY_REFRESH_FAILED]`, `[BATCH_COURSE_AUTOCREATE_FAILED]`, `[BATCH_CATALOG_BACKFILL_FAILED]` | Batch catalog |
| `[written-eval]`, `[llm-eval]`, `[web-eval]` | AI/web evaluators (provider errors, retries, fallback) |
| `*_EMAIL_FAILED`, `*_NOTIFY_FAILED` | Email/notification fan-out failures (best-effort) |

## 5. Common failure modes

| Symptom | Cause | Check / fix |
|---|---|---|
| 503 `DB_NOT_CONNECTED` on every route including `/health` | MongoDB unreachable, wrong `MONGODB_URI`, Atlas IP allow-list | grep `DB_CONNECT_*`; try `MONGODB_URI_DIRECT` if SRV DNS fails |
| Vercel: every request fails after one bad cold start | `api/index.js` caches a rejected `connectDb()` promise | Redeploy / wait for instance recycle; see [ARCHITECTURE.md](ARCHITECTURE.md) |
| Users never get OTP emails, "OTP sent" still returned | `BREVO_API_KEY` / `BREVO_SENDER_EMAIL` missing or Brevo error; the send error is swallowed | Logs show `[OTP_DEBUG] OTP email send failed: ...` with the reason. In production the OTP itself is not printed unless `OTP_DEBUG_LOG=true` (temporary break-glass: set it, restart, then unset; it exposes login codes to anyone with log access) |
| Uploads fail with 503 `CLOUDINARY_NOT_CONFIGURED` ("File uploads are temporarily unavailable") | Cloudinary env missing | Set `CLOUDINARY_URL` or the three-variable form |
| Upload 400 `UPLOAD_ERROR` / `INVALID_FILE` | Multer size limit (2-25 MB depending on the upload, see `upload.middleware.js`) or wrong file type | Client-side validation |
| 413 on large bodies | Nginx `client_max_body_size 20m` or Express JSON limit 2 MB | Adjust the relevant layer |
| PhonePe webhook 401 | Dashboard username/password differ from `PHONEPE_WEBHOOK_*` | `PHONEPE_WEBHOOK_SIG_FAIL`; sha256 of `username:password` must equal the `Authorization` header |
| PhonePe webhook 503 `CONFIRMATION_UNAVAILABLE` / 409 `WEBHOOK_UNCONFIRMED` | `PHONEPE_WEBHOOK_USERNAME/PASSWORD` unset, so each webhook is re-confirmed with PhonePe's status API: 503 = status call failed (PhonePe client creds missing/wrong or PhonePe down), 409 = PhonePe's state differs (forged, or PhonePe not yet updated; PhonePe retries) | Set both webhook variables in production; check `PHONEPE_CLIENT_*`; grep `PHONEPE_WEBHOOK_CONFIRM_*` |
| `POST /v1/auth/google` 503 `GOOGLE_NOT_CONFIGURED` | `GOOGLE_CLIENT_ID` unset (intentional since 2026-11-23) | Set it if Google sign-in is wanted |
| Payment initiate 502 `GATEWAY_ERROR` | PhonePe creds missing (`PhonePe not configured`) or API error; `PHONEPE_SANDBOX` wrong for the credentials | Check env and sandbox flag |
| Payment stuck `pending` | Webhook missed | Student status poll (`GET /students/payments/status/:id`) re-verifies with PhonePe; admin reconciliation: `GET /v1/admin/payments/reconciliation` |
| Written assignments return "grading service unavailable" | No `GEMINI_API_KEY`/`DEEPSEEK_API_KEY` or provider outage; result has `provider: "fallback"` | See [AI_EVALUATOR.md](AI_EVALUATOR.md) |
| No reminders / notifications on Vercel | No cron pinger | See section 1 |
| No post-session task notifications on EC2 | Tick is cron-only, and/or `POST_SESSION_TASKS_START_AT` unset | Add pinger; set the cutoff |
| No Meet links on new classes | `GOOGLE_CALENDAR_*` credentials missing (service loads lazily and reports not configured) | Set the three OAuth variables |
| Python code fails with a module-not-found hint on Vercel | `vercel.json` `includeFiles` dropped Pyodide | Keep `{node_modules/pyodide,src/services/runners}/**` |
| Everyone behind one IP gets 429 | `TRUST_PROXY` missing, or a classroom NAT | Set `TRUST_PROXY=1`; raise `RATE_LIMIT_API_MAX` |
| Staff suddenly logged out (401 "Session expired") | `token_version` bumped (logout, password change, account toggled) | Expected; log in again |

## 6. Operator scripts (names only; not run by this repo's automation)

| Command | What it does |
|---|---|
| `npm run create-super-admin` | Upserts a `super_admin` by `SUPER_ADMIN_EMAIL` with `SUPER_ADMIN_PASSWORD` (and optional `SUPER_ADMIN_NAME`). **Overwrites the password hash and reactivates an existing account with that email.** Login is still OTP-based. |
| `npm run seed` | `src/scripts/seed.js`: inserts/updates demo data (test student/admin accounts, announcements, notes, assignments, timetable, mentor slots, batches) in whatever database `MONGODB_URI` points at. Never run against production. |
| `node src/scripts/<name>.js [--apply]` | Remaining maintenance scripts: `backfill-enrollment-section-id`, `backfill-instructor-batches-all-catalog` (resets all instructors' batches), read-only `debug-enrollment-sync`. Read each script's header before use. See [batches-and-enrollment.md](batches-and-enrollment.md) for the removed one-shot migrations. |

## 7. Routine operations

- **Restart with new env (EC2)**: edit `~/codemasti/.env`, then `bash ~/codemasti/app/deploy/restart-container.sh`.
- **Rotate JWT secrets**: invalidates all sessions (students and staff must log in again).
- **Disable a staff account**: `PATCH /v1/staff/:id/active` (super_admin) bumps `token_version`, revoking tokens immediately.
- **Check a batch/billing mismatch**: `GET /v1/admin/enrollments/reconcile` lists mismatches and `POST` applies them (super_admin); the fix adds missing enrollments and never completes other active ones.

## 8. Alerting suggestions (not implemented in repo)

Pinger failures (non-200 from the cron URL), container `unhealthy`, spikes of `"statusCode":5`, and `PHONEPE_WEBHOOK_SIG_FAIL`.

## 9. Open items needing a decision

1. `postSessionTasks` is only reachable via the cron endpoint; decide whether EC2 should also start it in `server.js`.
2. Monthly invoice de-dupe is not backed by a unique index (`Invoice` has no `{enrollment_id, period_start}` constraint); a day-1 race with both timer and pinger on EC2 used to double-invoice. **Code fix (2026-11-23): `buildInvoiceForPeriod` now locks the enrollment document and re-checks for an existing invoice inside the transaction; untested against a real replica set.** The unique index is still not added. **Confirmed in production data (read-only check, 2026-11-23): 9 groups of duplicate invoices (18 documents, all `system_cron`), one of them paid + pending for the same period.** The existing duplicates are not cleaned up: review them, cancel or remove the extras, and only then consider a unique index on `{enrollment_id, period_start}`.
3. `api/index.js` caches a rejected DB-connect promise.
4. PhonePe webhook auth: **partly fixed (2026-11-23).** With `PHONEPE_WEBHOOK_USERNAME/PASSWORD` unset the webhook no longer trusts the body: payment and refund events are re-confirmed with PhonePe's order/refund status API before any state change (503 if the call fails, 409 if it disagrees); a `[SECURITY]` warning is logged at startup when `PAYMENTS_MODE=phonepe`. **Remaining:** set the two webhook variables in production so webhooks are authenticated by signature (and cost no extra PhonePe call). The configured-credentials path is unchanged and trusts the signed body. Also unverified: a refund webhook whose `payload` lacks `merchantOrderId`/`orderId` is normalised to `pending` by `normalizeProviderResponse` (see [BILLING.md](BILLING.md)); worth checking against a real refund webhook.
5. `UPI_PAYEE_VPA` / `UPI_PAYEE_NAME` have hard-coded fallbacks in `src/utils/paymentsConfig.js`. **Not changed (2026-11-23)**: production relies on them. Documented in the code, `.env.example` and [ENV.md](ENV.md); fix by setting both variables explicitly, then the fallback can be removed.
6. Data findings from a read-only production check on 2026-11-23 (counts only; nothing was changed):
   - 1 student has a `batch_id` but no active enrollment (innovators); `POST /v1/admin/enrollments/reconcile` would add it.
   - 16 active enrollments still lack `section_id` while the student has a legacy section; `backfill-enrollment-section-id` would stamp them.
   - 1 `personaldoubts.image_url` still points at a `/v1/static/...` path that no route serves any more, so that image is broken.
   - 4 collections have no model and no code reference: `scorecardconfigs` (1 doc), `scorecardmonths` (4), `remindersettings` (1), `studentbroadcastlogs` (0). They can be dropped once you confirm the data is not needed.
   - 2 collections are orphaned after the live-class removal: `liveclasses` and `classjoinaudits` (their models and routes were deleted; no code references them). They can be dropped once you confirm the data is not needed.
   - `Student.course` and `Student.progress` are empty/zero for every student.
7. Security hardening done 2026-11-23: OTP printing is off in production unless `OTP_DEBUG_LOG=true` (shared helper `src/utils/otpDebug.js`); `POST /v1/auth/google` refuses with 503 `GOOGLE_NOT_CONFIGURED` when `GOOGLE_CLIENT_ID` is unset. **Still open:** CORS with no `CORS_ORIGINS` reflects any origin with credentials (only a `[SECURITY]` startup warning in production was added; set `CORS_ORIGINS` and the warning disappears).
8. Known limits of the credential-less webhook confirmation (found in review, 2026-11-23):
   - The webhook route is mounted before the global rate limiter, so it is not rate limited. Without credentials each valid-looking request costs one PhonePe status call (8 s timeout). Setting `PHONEPE_WEBHOOK_USERNAME`/`PASSWORD` removes this.
   - Without credentials the stored `webhook_payload` is PhonePe's confirmed answer, not the request body, and an already-processed status is acknowledged without any outbound call.
   - A stale event (for example `FAILED` for an earlier attempt after the order is `COMPLETED`) gets 409 and PhonePe keeps retrying it until it gives up; this is intentional because the alternative would downgrade a paid payment.
   - The amount in PhonePe's answer is not compared with `Payment.amount_paise`.
   - Refund webhooks: `CONFIRMED` is stored as `pending` and a payload without `orderId`/`merchantOrderId` is stored as `pending` (`normalizeProviderResponse`); real refund payloads were not available to check.
