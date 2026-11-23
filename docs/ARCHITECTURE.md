# Architecture

Express 5 + MongoDB (Mongoose 9) API (`my-codemasti-server`), CommonJS, serving two React frontends. Facts below were checked against `src/`, `api/`, `Dockerfile`, `vercel.json` and `deploy/`.

## 1. System overview

```
 Students (browser)                         Staff (browser)
        |                                          |
 my-codemasti-com (Next.js 14)            my-codemasti-admin (React 19 + Vite)
 dev :3000                                dev :5173  (proxies /v1 -> :5001)
        |  Bearer JWT, localStorage                |  Bearer JWT, localStorage
        |  base = NEXT_PUBLIC_API_BASE_URL         |  base = "/v1" (same-origin)
        |                                          |  Vercel rewrite /v1/* ->
        |                                          |  https://server.codemasti.com/v1/*
        +------------------------+-----------------+
                                 v
              my-codemasti-server  (Express 5, /v1/*, port 5001)
        +-------------------------+-----------------------------+
        |  Runtime A: Vercel      |  Runtime B: Docker on EC2   |
        |  api/index.js           |  src/server.js              |
        |  lazy DB connect        |  DB connect at boot         |
        |  NO timers; cron pinger |  setInterval schedulers     |
        |  -> /v1/internal/cron/  |  Nginx :80/:443 -> 127.0.0.1|
        |     run                 |  :5001 (TRUST_PROXY=1)      |
        +-------------------------+-----------------------------+
              |            |             |            |            |
          MongoDB      Cloudinary      Brevo      Gemini /      Google Calendar
          (Atlas)      (uploads)     (email)     DeepSeek      (Meet links)
                                                                  PhonePe (payments, webhook -> server)
```

| Repo | Stack | Dev port | Entry |
|---|---|---|---|
| `my-codemasti-server` | Express 5, Mongoose 9, Zod 4, CommonJS | `5001` (`PORT`, default in `src/server.js`) | `src/server.js` (long-running), `api/index.js` (Vercel) |
| `my-codemasti-com` | Next.js 14 (App Router), TS, Tailwind, shadcn/ui, React Query | `3000` | `app/` |
| `my-codemasti-admin` | React 19, Vite 8, JSX, Tailwind v4, React Router 7 | `5173` | `src/main.jsx` |

Node `24.22.1` / npm `12.2.1` are pinned in the server's `package.json` `devEngines` (`onFail: error`), `.nvmrc` and the `Dockerfile` build args.

## 2. Server layering

`routes/modules/*.routes.js` -> `controllers/*.controller.js` -> `services/*.js` -> `models/*.js`, with shared helpers in `utils/`, request guards in `middlewares/`.

| Directory | Count (files) | Role |
|---|---|---|
| `src/routes/modules` | 22 | One router per area; mounted in `src/routes/index.js` (22 mounts: 20 prefixes, `/admin` and `/students` are each mounted twice) |
| `src/controllers` | 44 | HTTP handlers; Zod validation, `sendSuccess` / `sendError` |
| `src/services` | 37 (+ `runners/` subdir with `python-runner.js`) | Business logic, schedulers, third-party clients |
| `src/models` | 42 | Mongoose schemas (see section 9) |
| `src/utils` | 30 | Pure helpers: tokens, RBAC, batch registry, enrollment parsing, money, cloudinary |
| `src/middlewares` | 5 | `auth`, `staff`, `rateLimit`, `error`, `upload` (multer, memory storage) |
| `src/scripts` | 5 | CLI scripts (seed, create-super-admin, section-id backfill, instructor batch reset, enrollment-sync debug) |
| `src/config` | 2 | `db.js`, `achievement-badges.js` |

Counts come from `ls <dir> | wc -l`. The full route table is in [api/ROUTES.md](api/ROUTES.md) (275 routes + 3 in `app.js`).

## 3. Request path (`src/app.js`, in order)

1. `trust proxy` if `TRUST_PROXY` is set.
2. `cors` (`CORS_ORIGINS` + legacy `CORS_ORIGIN`; empty list => any origin), `credentials: true`.
3. `helmet` (`crossOriginResourcePolicy: cross-origin`).
4. `morgan("dev")` (skips the staff unread-count poll).
5. **PhonePe webhook** `POST /v1/payments/webhook/phonepe` with `express.raw` (before the JSON parser; also before rate limiting and DB-connect middleware).
6. `express.json` (2 MB), `express.urlencoded`.
7. `apiLimiter`: 200 req/min per IP (`RATE_LIMIT_API_MAX` overrides).
8. **Lazy DB connect middleware**: if `mongoose.connection.readyState !== 1`, connect (coalesced); on failure respond `503 DB_NOT_CONNECTED`.
9. `GET /health`, `GET /health/db` (after the DB middleware, so `/health` also 503s when the DB is unreachable).
10. `otpLimiter` (5/min) on `/v1/auth/otp` and `/v1/staff-auth/otp`.
11. `/v1` router (`src/routes/index.js`).
12. `notFoundHandler` (404 `NOT_FOUND`), `errorHandler` (Multer -> 400 `UPLOAD_ERROR`, Zod -> 400 `VALIDATION_ERROR`, else `err.statusCode`/500).

Multer uploads are memory-buffered and sent to Cloudinary; nothing is written to disk.

## 4. Response envelope

Use `sendSuccess(res, data, message?, meta?)` and `sendError(res, status, code, message, details?, serverOnlyLog?)` from `src/utils/response.js`.

```jsonc
{ "success": true,  "data": {...}, "message": "optional", "meta": {...} }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {...} } }
```

`sendSuccess` always responds HTTP 200. Every `sendError` (including 4xx) logs one `[ERROR] {"context":"API_ERROR",...}` line. Request validation uses Zod (`schema.parse` errors become `VALIDATION_ERROR` via `errorHandler`; many controllers use `safeParse` and return their own message).

## 5. Auth

Two flows share `src/utils/tokens.js` (HS256; access `JWT_ACCESS_EXPIRES_IN` default `1h`, refresh `JWT_REFRESH_EXPIRES_IN` default `30d`; separate secrets).

### Student (`/v1/auth/*`, middleware `requireAuth`)
- Students must already exist (created by an admin); every login path returns `STUDENT_NOT_REGISTERED` otherwise.
- **OTP**: `POST /auth/otp/send` stores an `OtpRequest` (6 digits, 120 s TTL) and emails it via Brevo; `POST /auth/otp/verify` returns `access_token` + `refresh_token`. If email sending throws, the error is swallowed and the OTP is logged unless `OTP_DEBUG_LOG=false`.
- **Password**: `POST /auth/login`. First-time set / reset use OTP -> short-lived (10 min) `signup_token` / `reset_token` -> `POST /auth/signup/password` / `/auth/password/reset`.
- **Google**: `POST /auth/google` verifies the ID token against Google's `tokeninfo` endpoint; checks `aud` only if `GOOGLE_CLIENT_ID` is set; maps to an existing student by email. No caller exists in either frontend today.
- `POST /auth/refresh` verifies the refresh token and issues a new access token (no rotation). `POST /auth/logout` is a stateless no-op; there is **no server-side revocation for student tokens**.
- `requireAuth` only verifies the bearer JWT and sets `req.user`; it does not distinguish student from staff tokens.

### Staff (`/v1/staff-auth/*`, middlewares `requireStaffAuth`, `requireStaffRoles([...])`)
- Same OTP / password / signup / reset flows, plus `POST /staff-auth/me/password/*` for self-service password change. Tokens carry `staff: true` and `tv` (token version).
- `requireStaffAuth` verifies the JWT, then **loads the Staff row on every request** and rejects (401) if the account is missing, `is_active` is false, or `tv !== token_version`. It sets `req.staff` and `req.user`.
- **Revocation**: `token_version` is incremented on logout, on every password set/reset/change, and on every activate/deactivate toggle (`staff-management.controller.js`). `POST /staff-auth/refresh` also compares `tv`, so refresh tokens die together with access tokens.
- Tokens issued before `tv` existed (no claim) are treated as `0`.

### RBAC (`src/utils/rbac.js`)
Roles: `super_admin`, `admin`, `instructor`, `mentor`. `ROLE_PERMISSIONS` is returned to the client for UI gating only; **routes enforce roles themselves** via `requireStaffRoles`.

| Role | Permissions returned to the client | Notable server rules |
|---|---|---|
| `super_admin` | staff:manage, staff:reset_password, students:manage, content:manage, live_classes:manage, doubt_sessions:manage, mentor_sessions:manage, dashboard:view, analytics:view, settings:manage | Only role that can manage staff; sole access to all billing routes (`admin-billing.routes.js`); can create admin/instructor/mentor |
| `admin` | students:manage, content:manage, live_classes:manage, doubt_sessions:manage, mentor_sessions:manage, dashboard:view, analytics:view | Most `/admin/*` content and student routes; can create instructor/mentor; no billing |
| `instructor` | notes:upload, live_classes:create, doubt_sessions:schedule, assignments:upload, batch_catalog:list, students:view_course, dashboard:view | Teaching modules, scoped to assigned batches in controllers |
| `mentor` | mentor_sessions:schedule, students:view_assigned, mentor_notes:add, progress:track, session_reports:view, dashboard:view | Own mentor sessions, batch list |

Helpers: `canManageStaff` (super_admin only), `canCreateRole`, `canDeleteStaff` (super_admin, never another super_admin), `canResetPassword` (super_admin).

## 6. Runtimes

| | Vercel serverless | Docker on EC2 |
|---|---|---|
| Entry | `api/index.js` wraps `src/app` | `src/server.js` |
| Config | `vercel.json`: routes `/v1/*`, `/health`, `/health/db` -> `api/index.js`; `maxDuration: 30`; `includeFiles` for `node_modules/pyodide` and `src/services/runners` | `Dockerfile` (Alpine, tini, non-root UID 10001), `deploy/*.sh`, `deploy/nginx-codemasti.conf` |
| DB | Connected lazily on first request per instance (`api/index.js` caches the connect promise; `app.js` also self-heals) | Connected at boot (`bootstrap()` exits on failure) |
| Schedulers | None (timers cannot fire) -> external pinger calls `/v1/internal/cron/run` | `setInterval` timers started in `bootstrap()` |
| Proxy | Vercel | Nginx -> `127.0.0.1:5001`, `TRUST_PROXY=1` |

Details: [DEPLOYMENT.md](DEPLOYMENT.md). Observation: `api/index.js` caches `connectDb()`'s promise even if it rejects, so a failed first connect poisons that instance until it is recycled.

## 7. Schedulers and cron

`src/server.js` starts, in-process: mentor reminders (60 s), timetable class reminders (60 s), timetable event reminders (60 s), mentor publish sweep (60 s), assignment-release notifications (60 s), notification cleanup (24 h) and monthly invoices (1 h, acts on UTC day 1). `src/services/cron-runner.js` runs seven idempotent ticks for the cron endpoint (the cleanup scheduler is deliberately excluded; the post-session-tasks tick is **only** reachable through the cron endpoint). Idempotency is by atomic `updateOne({field: null}) -> *_sent_at` claims. Full table and operating notes: [RUNBOOK.md](RUNBOOK.md).

## 8. Domain pointers

- **Code runners** (student code in assignments): `src/services/js-executor.js` spawns `node --eval` with an empty env, 5 s timeout, 1 MB output cap, after a regex blocklist (`require`, `process.env`, `fs`, `eval`, ...). `src/services/python-wasm-executor.js` spawns `runners/python-runner.js`, which runs Pyodide (WebAssembly; no Python binary on the server) with an empty env; `assignment.controller.js` passes 8 s for a single run and `8 s + 3 s per hidden test` for submissions (module defaults 20 s / 25 s). Both executors are used from `assignment.controller.js`. Web (HTML/CSS) submissions are graded by `src/services/web-evaluator.js` (cheerio / css-tree DOM checks).
- **AI evaluator**: written answers only (coding is graded by running tests, not by an LLM). Gemini preferred if `GEMINI_API_KEY`, else DeepSeek, with a 4-layer prompt-injection defence. See [AI_EVALUATOR.md](AI_EVALUATOR.md).
- **Billing**: Course / StudentEnrollment / Invoice / Payment / ManualPayment / Refund, manual UPI (default) or PhonePe Standard Checkout v2, monthly invoice scheduler. See [BILLING.md](BILLING.md).
- **Batches and enrollment**: `BatchCatalog` + `batch-catalog-registry.js` + `StudentEnrollment` as the membership source. See [batches-and-enrollment.md](batches-and-enrollment.md).
- **Other modules**: contests (`contest.*`, `Contest`), badges / XP / monthly leaderboard (`achievement-badge-definition.service`, `badge-program.service`, `monthly-leaderboard-badge.service`, `weekly-climb-badge.service`, `xp-aggregation.service`, `AssignmentXpGrant`), mentor sessions (`MentorSlot`, `mentor-*` services), doubts and support chat, referrals (`referralRewards.js`, `ReferralEvent`), notifications (student + staff panel).

## 9. Models (`src/models`, 42)

| Domain | Models |
|---|---|
| Identity and auth | `Student`, `Staff`, `OtpRequest`, `StaffOtpRequest` |
| Batches and billing | `BatchCatalog`, `Course`, `StudentEnrollment`, `Invoice`, `Payment`, `ManualPayment`, `Refund` |
| Learning content | `Announcement`, `Note`, `LiveClass`, `Assignment`, `AssignmentQuestion`, `AssignmentSubmission`, `AssignmentXpGrant`, `ArenaQuestion`, `ArenaSubmission` |
| Schedule and sessions | `TimetableSlot`, `TimetableEvent`, `ClassJoinAudit`, `MentorSlot`, `MentorSessionJoin` |
| Assessment and gamification | `ScorecardTest`, `ScorecardEntry`, `Contest`, `AchievementBadgeDefinition`, `BadgeProgram`, `StudentAchievementBadge`, `MonthlyLeaderboardBadge`, `StudentLeaderboardGapState` |
| Doubts and support | `PersonalDoubt`, `CommunityMessage`, `SupportConversation`, `SupportMessage` |
| Notifications and ops | `Notification`, `StaffPanelNotification`, `StaffPanelNotificationState`, `AdminTodoTask` |
| Referral | `ReferralEvent` |

## 10. Frontends

| | Student portal | Admin panel |
|---|---|---|
| API client | `lib/auth-client.ts` (`request()`, `apiRequest()`, `apiRequestWithMeta()`), plus `lib/*-api.ts` | `src/api/client.js` (`apiFetch()`) |
| Base URL | `NEXT_PUBLIC_API_BASE_URL` (`/v1` appended); forced to `http://localhost:5001/v1` when the browser is on `localhost`/`127.0.0.1` (`lib/api-base.ts`) | `VITE_API_URL` or same-origin `/v1`, proxied by Vite (dev, `VITE_API_PROXY_TARGET`, default `127.0.0.1:5001`) and by the Vercel rewrite (prod) |
| Token storage | `localStorage`: `codemasti_access_token`, `codemasti_refresh_token`, `codemasti_student`, legacy `codemasti_token`, `codemasti_selected_batch_id` | `localStorage`: `staff_access_token`, `staff_refresh_token` (`src/constants/auth-storage.js`) |
| Refresh | On 401 for authed calls, one shared in-flight `POST /auth/refresh`, then retry | On 401, one shared in-flight `POST /staff-auth/refresh`; genuine rejection triggers a session-expired handler (logout) |
| Batch scoping | Auto-appends `?batch_id=<selected>` to batch-scoped paths (skipped for `/auth/`, `/students/me`, `/students/courses`, `/students/payments`, `/referral`, `/leaderboard`) | n/a |
| Data layer | React Query with an allow-listed persisted cache (`cm-rq-cache`, versioned) | React Query (`useQuery` in 25 files) |
| Deploys | Vercel assumed; **unverified** (no `vercel.json`; nothing in the repo proves the host) | Vercel (`vercel.json` rewrites `/v1/*` to `https://server.codemasti.com/v1/*`, SPA fallback) |

## 11. External integrations

| Service | Used for | Code | Env |
|---|---|---|---|
| Cloudinary | Note/assignment/doubt/payment-proof uploads, student avatars, staff media | `src/utils/cloudinary.js`, `middlewares/upload.middleware.js` | `CLOUDINARY_*` |
| Brevo | OTP and notification emails (HTTP API) | `src/services/brevo.js` | `BREVO_*` |
| Google Calendar | Meet links + invites for timetable/mentor slots | `src/services/google-calendar-meet.service.js` | `GOOGLE_CALENDAR_*` |
| Gemini / DeepSeek | Written-answer grading | `src/services/deepseek-evaluator.js` | `GEMINI_*`, `DEEPSEEK_*` |
| PhonePe | Hosted checkout, status polling, refunds, webhook | `src/services/phonepe-gateway.service.js`, `controllers/payments-webhook.controller.js` | `PHONEPE_*`, `PAYMENTS_MODE` |
| Google Identity | ID-token verification for `/auth/google` | `auth.controller.js` | `GOOGLE_CLIENT_ID` |

All variables: [ENV.md](ENV.md).
