# Environment variables

Derived from code (`grep process.env` over `src/`, `api/`, `loadtest/`, `deploy/`, `Dockerfile`; portal `process.env.NEXT_PUBLIC_*`; admin `import.meta.env`). Names, purposes and defaults only — never commit values. Each repo has its own `.env` (the server also reads it via `dotenv` in `src/server.js` and the scripts; on Vercel the variables come from the project settings; on EC2 from `~/codemasti/.env` passed with `--env-file`, see [DEPLOYMENT.md](DEPLOYMENT.md)).

"Required" = the feature fails or the server refuses to work without it. Everything else degrades gracefully as noted.

## 1. Server (`my-codemasti-server`)

### Core, auth, networking

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `MONGODB_URI` | **yes** | none; `connectDb` throws `MONGODB_URI is missing` (`src/config/db.js`) | yes | MongoDB connection string. Needs a replica set / Atlas (invoice generation and enrollment sync use transactions). |
| `MONGODB_URI_DIRECT` | no | empty (`src/config/db.js`) | yes | Non-SRV host-list URI. If set and different from `MONGODB_URI` it is tried first, with `MONGODB_URI` as fallback. |
| `JWT_ACCESS_SECRET` | **yes** | none (`src/utils/tokens.js`) | yes | HS256 secret for access tokens (student, staff and the short-lived signup/reset/password-update tokens). |
| `JWT_REFRESH_SECRET` | **yes** | none (`src/utils/tokens.js`) | yes | Secret for refresh tokens. |
| `JWT_ACCESS_EXPIRES_IN` | no | `1h` (`src/utils/tokens.js`) | no | Access-token lifetime. Note login/refresh responses hard-code `expires_in_sec: 3600` regardless. |
| `JWT_REFRESH_EXPIRES_IN` | no | `30d` (`src/utils/tokens.js`) | no | Refresh-token lifetime. |
| `PORT` | no | `5001` (`src/server.js`, `Dockerfile`) | no | HTTP port (long-running mode only; ignored on Vercel). |
| `CORS_ORIGINS` | prod: yes | empty => any origin allowed (`src/app.js`) | no | Comma-separated allowed origins (trailing `/` stripped). Empty list means `cors({ origin: true })`, i.e. every origin is reflected **with credentials**. Behaviour is unchanged, but with `NODE_ENV=production` and no origins configured the server prints a `[SECURITY]` warning once at startup. |
| `CORS_ORIGIN` | no | empty (`src/app.js`) | no | Legacy alias, merged with `CORS_ORIGINS` and de-duplicated. |
| `TRUST_PROXY` | behind proxy: yes | unset (`src/app.js`) | no | Passed to Express `trust proxy` (`Number(x) \|\| x`). Set to `1` behind Nginx so rate limiting uses the real client IP. `deploy/restart-container.sh` sets it. |
| `RATE_LIMIT_API_MAX` | no | `200` req/min/IP (`src/middlewares/rateLimit.middleware.js`) | no | Global limiter cap. Raised temporarily by `loadtest/run-stress-test.sh`. The OTP limiter (5/min) is fixed. |
| `CRON_SECRET` | prod: yes | none; endpoint returns 503 `CRON_NOT_CONFIGURED` (`src/routes/modules/internal.routes.js`) | yes | Shared secret for `GET\|POST /v1/internal/cron/run` (`x-cron-secret` header or `?key=`). |
| `OTP_DEBUG_LOG` | no | unset => log only when `NODE_ENV` is not `production` (`src/utils/otpDebug.js`, used by `auth`, `staff-auth`, `student` controllers) | no | When the OTP email fails to send, the OTP is written to stdout only if `OTP_DEBUG_LOG=true`, or `NODE_ENV!=production` and the value is not `false`. `false` always disables it. The send failure itself is always logged (without the OTP). Since 2026-11-23 production no longer prints OTPs by default. |
| `GOOGLE_CLIENT_ID` | to use Google sign-in | unset => `POST /v1/auth/google` returns 503 `GOOGLE_NOT_CONFIGURED` (`src/controllers/auth.controller.js`) | no | Expected `aud` of Google ID tokens for `POST /v1/auth/google`. Before 2026-11-23 an unset value skipped the audience check; it now refuses instead. No frontend calls this route. |

### Email (Brevo), uploads (Cloudinary), links

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `BREVO_API_KEY` | for email | none (`src/services/brevo.js`) | yes | Brevo API key. Without it OTP/notification emails fail (OTP falls back to console log, see `OTP_DEBUG_LOG`). |
| `BREVO_SENDER_EMAIL` | for email | none (`src/services/brevo.js`) | no | Verified sender address. |
| `BREVO_SENDER_NAME` | no | `CodeMasti` | no | Sender / brand name in emails. |
| `BREVO_TEMPLATE_ID` | no | unset => built-in OTP HTML (`brevo.js`) | no | Brevo template id for OTP emails. |
| `BREVO_OTP_SUBJECT` | no | `Your CodeMasti login code` | no | Subject of the built-in OTP email. |
| `CLOUDINARY_URL` | for uploads | unset (`src/utils/cloudinary.js`) | yes | Single-URL Cloudinary config; takes precedence over the trio below. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for uploads (all three) | unset | key/secret: yes | Alternative to `CLOUDINARY_URL`. If not configured, upload routes return 503 `CLOUDINARY_NOT_CONFIGURED`. |
| `CLOUDINARY_NOTES_FOLDER` / `_USE_DATE` | no | `codemasti/notes` / `true` | no | Folder root for note assets; `_USE_DATE` (`false`/`0` disables) adds `YYYY/MM`. |
| `CLOUDINARY_ASSIGNMENTS_FOLDER` / `_USE_DATE` | no | `codemasti/assignments` / `true` | no | Assignment assets. |
| `CLOUDINARY_ASSIGNMENT_QUESTIONS_FOLDER` / `_USE_DATE` | no | `codemasti/assignments/questions` / `true` | no | Assignment-question assets. |
| `CLOUDINARY_DOUBTS_FOLDER` / `_USE_DATE` | no | `codemasti/doubts` / `true` | no | Doubt attachments. |
| `CLOUDINARY_BADGE_PROGRAMS_FOLDER` / `_USE_DATE` | no | `codemasti/badge-programs` / `true` | no | Badge-program art. |
| `CLOUDINARY_PAYMENT_PROOFS_FOLDER` / `_USE_DATE` | no | `codemasti/payments/proofs` / `true` | no | Manual UPI payment screenshots. |
| `CLOUDINARY_COMMUNITY_FOLDER` / `CLOUDINARY_COMMUNITY_USE_DATE` | no | `codemasti/community` / `true` | no | Community-doubt images. |
| `CLOUDINARY_STUDENTS_ROOT` | no | `codemasti/students` | no | Student avatar root (`{root}/profiles/{id}`). |
| `CLOUDINARY_STAFF_ROOT` | no | `codemasti/staff` | no | Staff profile image/resume root. |
| `STUDENT_PORTAL_URL` | no | empty (`src/services/student-notifications.service.js`) | no | Base URL used for links in student emails. |
| `ADMIN_PORTAL_URL` | no | empty (`instructor-notifications.service.js`, `mentor-slot-lifecycle.service.js`) | no | Base URL used for links in staff emails. |
| `PUBLIC_APP_URL` | no | `https://codemasti.com` (`src/controllers/referral.controller.js`) | no | Base for the default referral link (`<base>/register`). |
| `REFERRAL_LINK_BASE` | no | `${PUBLIC_APP_URL}/register` | no | Full override of the referral link base. |
| `CONTEST_RESULTS_BASE_URL` | no | `https://counsellor.codemasti.com/result` (`src/utils/contestResultsUrl.js`) | no | Base of the public contest-results link. |
| `SUPPORT_EMAIL` | no | `support@codemasti.com` | no | Reply/support address shown in emails. |
| `EMAIL_LOGO_URL` | no | empty | no | Logo in email header. |
| `EMAIL_BRAND_PRIMARY`, `EMAIL_BRAND_PRIMARY_DARK`, `EMAIL_BRAND_HEADER_FROM`, `EMAIL_BRAND_HEADER_TO` | no | `#f97316`, `#ea580c`, `#0b1220`, `#1f2937` | no | Email theme colours. |

### Google Calendar (Meet links)

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN` | for Meet links (all three) | unset => feature disabled (`src/services/google-calendar-meet.service.js`) | secret/token: yes | OAuth2 credentials used to create calendar events with Meet links and send invites. |
| `GOOGLE_CALENDAR_ID` | no | `primary` | no | Calendar to write events to. |
| `GOOGLE_CALENDAR_TIME_ZONE` | no | `Asia/Kolkata` | no | Event time zone. |
| `GOOGLE_CALENDAR_TIMEZONE` | no | alias | no | Fallback alias read only by the calendar service (`TIME_ZONE` wins). |
| `CLASS_TIMEZONE` | no | falls back to `GOOGLE_CALENDAR_TIME_ZONE`, then `Asia/Kolkata` (`src/utils/timetable-slot-start.js`) | no | Time zone used to interpret timetable slot date/time strings. |

### AI evaluator (see [AI_EVALUATOR.md](AI_EVALUATOR.md))

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `GEMINI_API_KEY` | one of Gemini/DeepSeek for written grading | unset (`src/services/deepseek-evaluator.js`) | yes | If set, Gemini is used (preferred). |
| `GEMINI_MODEL` | no | `gemini-3.5-flash` | no | Gemini model id. |
| `DEEPSEEK_API_KEY` | see above | unset | yes | Used only when `GEMINI_API_KEY` is unset. |
| `DEEPSEEK_MODEL` | no | `deepseek-v4-flash` | no | DeepSeek model id. |

### Payments (see [BILLING.md](BILLING.md))

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `PAYMENTS_MODE` | no | `manual_upi` (`src/utils/paymentsConfig.js`) | no | `manual_upi` or `phonepe` (anything else => `manual_upi`). Reported to clients by `GET /v1/students/payments/config`. |
| `UPI_PAYEE_VPA` | for manual UPI | hard-coded fallback in `src/utils/paymentsConfig.js` (production currently relies on it) | no | UPI id shown to students and stored on each manual payment. **Set explicitly; do not rely on the code default.** The fallback is deliberately unchanged for now (open item). |
| `UPI_PAYEE_NAME` | for manual UPI | hard-coded fallback in `paymentsConfig.js` (production currently relies on it) | no | Payee display name. Same note as above. |
| `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET` | for PhonePe | none; `getConfig()` throws (`src/services/phonepe-gateway.service.js`) | yes | OAuth client credentials (Standard Checkout v2). |
| `PHONEPE_CLIENT_VERSION` | no | `1` | no | OAuth `client_version`. |
| `PHONEPE_SANDBOX` | prod: set `false` | `true` (anything except `false`/`0`/`no` is sandbox) | no | Selects sandbox vs production PhonePe hosts. |
| `PHONEPE_REDIRECT_URL_BASE` | for PhonePe | `http://localhost:3000/checkout/return` | no | Where PhonePe sends the student after payment (portal route). |
| `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD` | prod: yes (both) | empty => header not checked; every webhook is instead re-confirmed with PhonePe's status API before any state change (`payments-webhook.controller.js`), and `[SECURITY]` is warned at startup if `PAYMENTS_MODE=phonepe` | yes | Must match the dashboard values; PhonePe sends `Authorization: sha256("username:password")`. If only one is set it counts as unset. |

### Schedulers and retention

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `BILLING_INVOICE_SCHEDULER` | no | enabled; `0` disables (`src/services/monthly-invoice.scheduler.js`) | no | Disables the in-process monthly invoice scheduler only. Does **not** stop the cron endpoint from running the same tick. |
| `ASSIGNMENT_RELEASE_NOTIFY_SCHEDULER` | no | enabled; `0` disables (`assignment-release-notification.scheduler.js`) | no | Same, for assignment-release notifications (in-process only). |
| `POST_SESSION_TASKS_START_AT` | for post-session tasks | unset => feature disabled (`src/utils/post-session-tasks-config.js`) | no | ISO-8601 cutoff; only sessions ending at/after it get post-class/post-session task notifications. |
| `STUDENT_NOTIF_DELETE_READ_AFTER_DAYS` | no | `30` (`notification-cleanup.scheduler.js`) | no | Retention for read student notifications. |
| `STUDENT_NOTIF_DELETE_UNREAD_AFTER_DAYS` | no | `120` | no | Retention for unread student notifications. |
| `STAFF_NOTIF_DELETE_AFTER_DAYS` | no | `180` | no | Retention for staff panel notifications. |

### Script-only (read by `src/scripts/*`)

| Variable | Used by | Default | Secret? | Purpose |
|---|---|---|---|---|
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | `npm run create-super-admin` | none (script exits) | password: yes | Account to upsert. |
| `SUPER_ADMIN_NAME` | same | `Super Admin` | no | Display name. |

### Set by the platform, not by `src/`

| Variable | Where | Note |
|---|---|---|
| `NODE_ENV` | `Dockerfile` (`production`), `deploy/restart-container.sh` (`-e NODE_ENV=production`), Vercel (sets `production` automatically) | Read by `src/utils/otpDebug.js` (OTP logging) and `src/app.js` (CORS startup warning); also by Express internally. Local `npm run dev` leaves it unset, which counts as non-production. |
| `PORT`, `TRUST_PROXY` | `deploy/restart-container.sh` (`5001`, `1`) | Override anything in `~/codemasti/.env`. |

## 2. Student portal (`my-codemasti-com`)

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | prod: yes | `http://localhost:5001/v1` (`lib/api-base.ts`) | no (public) | API base; `/v1` is appended if missing. Inlined at build time. Also feeds the host allow-list of `app/api/media/route.ts`. |
| `NEXT_PUBLIC_SITE_URL` | prod: yes (SEO) | `http://localhost:3000` (`lib/site-metadata.ts`) | no | Canonical / Open Graph origin. |

`NODE_ENV` is also read in `components/providers/query-provider.tsx` (dev-only logging). There is no Google client id or other public key in the portal code.

## 3. Admin panel (`my-codemasti-admin`)

| Variable | Required? | Default (where) | Secret? | Purpose |
|---|---|---|---|---|
| `VITE_API_URL` | no | `/v1` same-origin (`src/api/client.js`) | no (public) | API base. Leave unset to use the proxy (Vite in dev, `vercel.json` rewrite in prod). If set to an absolute URL the server must allow the origin via `CORS_ORIGINS`. |
| `VITE_API_PROXY_TARGET` | no | `http://127.0.0.1:5001` (`vite.config.js`) | no | Dev-server proxy target for `/v1`. Build-time/dev only. |

## 4. Shell-only variables (deploy and load test)

Not read by the app. Read by `deploy/*.sh` and `loadtest/*`.

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `EC2_HOST` | `deploy-ec2.sh`, `setup-ssl.sh`, `run-stress-test.sh` | an `ec2-user@…ap-southeast-2…` host baked into each script | SSH target. |
| `EC2_KEY` | same | `$HOME/Downloads/server-ssh.pem` | SSH identity file. |
| `DOMAIN` | `setup-ssl.sh` | `server.codemasti.com` | Domain for the Let's Encrypt cert. |
| `CERTBOT_EMAIL` | `setup-ssl.sh` | required | Expiry notices email. |
| `STUDENT_EMAIL`, `STUDENT_PASSWORD` | `run-stress-test.sh`, `stress-test.js` | required | Test student (password login). |
| `KEEP_RATE_LIMIT` | `run-stress-test.sh` | unset | `1` keeps the real 200/min limiter during the test. |
| `BASE_URL` | `stress-test.js` | `https://server.codemasti.com/v1` | Target API. |
| `USERS`, `RAMP_SEC`, `HOLD_SEC` | `stress-test.js` | `500`, `60`, `180` | Virtual users, ramp-up and hold seconds. |
| `THINK_MIN_MS`, `THINK_MAX_MS`, `TIMEOUT_MS` | `stress-test.js` | `2000`, `5000`, `30000` | Think time and request timeout. |
| `LOGIN_MODE` | `stress-test.js` | `each` (`shared` = one login) | Login strategy. |
| `TARGET_P95_MS`, `TARGET_ERROR_PCT` | `stress-test.js` | `1000`, `1` | Pass/fail thresholds in the report. |
| `OUT_DIR` | `stress-test.js` | `loadtest/reports/<timestamp>` | Report output. |
| `SSH_KEY`, `SSH_HOST` | `stress-test.js` | set by `run-stress-test.sh` | CPU/memory sampling over SSH. |

## 5. Production safety checklist

- [ ] `NODE_ENV=production` (Docker, `restart-container.sh` and Vercel already do this). With it, OTPs are never printed unless you explicitly set `OTP_DEBUG_LOG=true`; leave `OTP_DEBUG_LOG` unset or `false`.
- [ ] `CORS_ORIGINS` set to the exact portal/admin origins (empty means every origin is reflected with credentials; a `[SECURITY]` warning is printed at startup in production).
- [ ] `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` set to long random, distinct values.
- [ ] `GOOGLE_CLIENT_ID` set only if you want `/v1/auth/google` to work (unset => 503 `GOOGLE_NOT_CONFIGURED`). No frontend calls this route today.
- [ ] `CRON_SECRET` set, and the cron pinger configured (mandatory on Vercel; also needed on EC2 for the post-session tasks tick, see [RUNBOOK.md](RUNBOOK.md)).
- [ ] `TRUST_PROXY=1` when behind Nginx / a load balancer (set automatically by `deploy/restart-container.sh`).
- [ ] If `PAYMENTS_MODE=phonepe`: `PHONEPE_CLIENT_ID/SECRET`, `PHONEPE_SANDBOX=false`, `PHONEPE_REDIRECT_URL_BASE`, and **`PHONEPE_WEBHOOK_USERNAME/PASSWORD`** (unset => webhooks are unauthenticated and only accepted after a PhonePe status-API re-confirmation; a `[SECURITY]` warning is logged at startup).
- [ ] `UPI_PAYEE_VPA` / `UPI_PAYEE_NAME` set explicitly for manual UPI (the hard-coded fallback in `paymentsConfig.js` still exists and production relies on it today).
- [ ] `BREVO_API_KEY` + `BREVO_SENDER_EMAIL` set (OTP login depends on email).
- [ ] Cloudinary configured (uploads return 503 otherwise).
- [ ] `STUDENT_PORTAL_URL`, `ADMIN_PORTAL_URL`, `PUBLIC_APP_URL`/`REFERRAL_LINK_BASE` set to production URLs (links in emails).
- [ ] Portal build has `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_SITE_URL`.

## 6. Known gotchas

- **Portal forces the local API on localhost.** `lib/api-base.ts` returns `http://localhost:5001/v1` whenever the browser hostname is `localhost` or `127.0.0.1`, ignoring `NEXT_PUBLIC_API_BASE_URL`. The admin client does **not** do this; it uses `VITE_API_URL` or the `/v1` proxy.
- **`CORS_ORIGIN` is a legacy alias** of `CORS_ORIGINS`; both are merged.
- **`GOOGLE_CALENDAR_TIMEZONE` is an alias** of `GOOGLE_CALENDAR_TIME_ZONE`, honoured only inside the calendar service. `CLASS_TIMEZONE` falls back to `GOOGLE_CALENDAR_TIME_ZONE` only (not the alias).
- **`BATCH_MEMBERSHIP_SOURCE` is no longer read by any code.** Membership is always resolved from `StudentEnrollment`. The name survives only in a comment in `src/scripts/backfill-enrollment-section-id.js` and in the admin docs page. Remove it from any env file.
- **`OTP_DEBUG_LOG` default depends on `NODE_ENV` (changed 2026-11-23):** unset/other values log OTPs only outside production; `true` forces logging, `false` forbids it. If production email is broken and `OTP_DEBUG_LOG` is not `true`, the OTP is not recoverable from logs (only the send failure is logged).
- **Webhook without credentials is not open any more, but is not authenticated either:** with `PHONEPE_WEBHOOK_USERNAME/PASSWORD` unset, `POST /v1/payments/webhook/phonepe` accepts the request but re-confirms the order/refund with PhonePe before applying it (503 if PhonePe cannot be reached so PhonePe retries, 409 if PhonePe disagrees). This needs `PHONEPE_CLIENT_ID/SECRET`; without them every webhook is answered 503. Configure the webhook credentials to remove the extra API call per webhook.
- **CORS with no configured origin reflects every origin with credentials** (unchanged; only a startup warning was added).
- **`UPI_PAYEE_VPA` / `UPI_PAYEE_NAME` silently fall back to hard-coded values** if unset; production depends on this, so it was left as is.
- **`BILLING_INVOICE_SCHEDULER=0` / `ASSIGNMENT_RELEASE_NOTIFY_SCHEDULER=0` only affect the in-process timers** in `src/server.js`. The cron endpoint runs those ticks regardless.
- **`PAYMENTS_MODE` is advisory for clients:** `POST /v1/students/payments/initiate` (PhonePe) does not check the mode; it only requires PhonePe credentials.
- **Access-token TTL is configurable but clients are told 3600s** (`expires_in_sec` is hard-coded in the auth controllers).
- **Vite/Next inline `VITE_*` / `NEXT_PUBLIC_*` at build time**; changing them requires a rebuild/redeploy.
