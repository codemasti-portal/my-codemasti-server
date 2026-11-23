# CodeMasti Backend (Express + MongoDB)

REST API behind the CodeMasti student portal (`my-codemasti-com`) and the staff/admin panel (`my-codemasti-admin`). It handles student and staff authentication, course content (notes, assignments, arena questions, contests, timetable), mentor sessions, doubts and support chat, notifications, leaderboards and badges, referrals, and fee billing and payments.

## Tech Stack

- Node.js + Express 5 (CommonJS)
- MongoDB + Mongoose 9
- Zod 4 request validation
- JWT auth (access + refresh tokens) for two separate flows: students (`/v1/auth/*`) and staff (`/v1/staff-auth/*`)
- helmet, cors, morgan and express-rate-limit (global API limiter plus OTP limiters)
- multer (in-memory) uploading to Cloudinary: notes, assignment files, avatars and payment proofs
- Brevo for transactional email (OTP and notifications)
- Google Calendar API for timetable Meet links and invites
- AI evaluator for coding and written assignment submissions: Gemini preferred, DeepSeek as fallback
- PhonePe (v2, OAuth) payment gateway, plus a manual UPI flow selected by `PAYMENTS_MODE`
- Code runners for student submissions: Pyodide (Python via WASM) and a JavaScript executor that spawns child processes

## Setup

1. Install the required Node and npm versions (Node `24.22.1`, npm `12.2.1`).

If you don't have nvm yet (check with `nvm --version`), install it on macOS:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
source ~/.zshrc             # or open a new terminal
nvm --version               # should print 0.40.8
```

Then install Node and npm:

```bash
nvm install                 # reads .nvmrc → Node 24.22.1
nvm use
npm install -g npm@12.2.1
node -v && npm -v           # should print v24.22.1 and 12.2.1
```

These versions are enforced via `devEngines` in `package.json` — `npm install` fails with `EBADDEVENGINES` on any other Node/npm version. The `Dockerfile` pins the same versions.

2. Copy the env file and fill it in:

```bash
cp .env.example .env
```

At minimum set `MONGODB_URI`, `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`. Every variable, with defaults and a production-safety checklist, is documented in `.env.example`.

3. Install and run:

```bash
npm install
npm run dev
```

The server listens on `http://localhost:5001` by default (override with `PORT`).

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `nodemon src/server.js` (auto-restart) |
| `npm start` | `node src/server.js` |
| `npm run seed` | Runs `src/scripts/seed.js` |
| `npm run create-super-admin` | Bootstraps the first super admin (reads `SUPER_ADMIN_*` from `.env`) |

The other files in `src/scripts/` are one-off backfill and maintenance scripts run manually with `node`. They write to the database, so read a script before running it.

## API

All APIs are under the `/v1` prefix. Example: `GET /v1/auth/me`, `GET /v1/students/me`.

### Response contract

Success:

```json
{
  "success": true,
  "data": {},
  "message": "optional",
  "meta": { "page": 1, "limit": 20, "total": 100 }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field invalid",
    "details": {}
  }
}
```

### Route groups

Mounted in `src/routes/index.js` (modules in `src/routes/modules/`):

| Prefix | Module | Description |
| --- | --- | --- |
| `/v1/auth` | auth | Student auth: OTP send/verify, password login, signup, password reset, Google sign-in, token refresh, logout, `me` |
| `/v1/staff-auth` | staff-auth | Staff auth (separate flow): OTP, password login, signup, password reset |
| `/v1/staff` | staff-management | Staff profile (photo, resume upload) and super-admin staff account management |
| `/v1/students` | student | Student profile, avatar, OTP-based password update, achievements |
| `/v1/students` | student-billing | Student fees: courses/enrollments, payment config, PhonePe initiate/status, manual UPI payment proofs |
| `/v1/dashboard` | dashboard | Student dashboard summary and home data |
| `/v1/notes` | notes | Notes list, filters, detail, download |
| `/v1/assignments` | assignment | Assignments list, filters, question detail, run, submit, submissions |
| `/v1/arena` | arena | Practice question arena: activity, solved, questions, submit, submissions |
| `/v1/contests` | contest | Contests list and detail for students |
| `/v1/timetable` | timetable | Weekly timetable and events |
| `/v1/admin` | admin | Admin/instructor panel: announcements, notes, assignments, arena, contests, students, batches, timetable, uploads |
| `/v1/admin` | admin-billing | Admin billing: courses, enrollments, invoices, reconciliation, manual payment review |
| `/v1/leaderboard` | leaderboard | Leaderboard, a student's own rank, monthly winners |
| `/v1/mentor-sessions` | mentor-sessions | Mentor slots: list, book, cancel, join |
| `/v1/doubts` | doubts | Personal doubts and community chat channels |
| `/v1/support` | support | Student support chat conversations and messages |
| `/v1/notifications` | notifications | Student in-app notifications: list, unread count, mark read |
| `/v1/staff/panel-notifications` | staff-panel-notifications | Staff in-app notifications and admin broadcast |
| `/v1/internal` | internal | `GET`/`POST /cron/run`, the cron trigger (see below) |
| `/v1/referral` | referral | Referral link and events |

The PhonePe webhook, `POST /v1/payments/webhook/phonepe`, is mounted directly in `src/app.js`, ahead of the JSON body parser, because it needs the raw body for verification.

### Health

- `GET /health` — liveness; always `200` if the process is up.
- `GET /health/db` — pings MongoDB; `503` if the database is not connected.

### Cron endpoint

`GET` or `POST /v1/internal/cron/run` runs one pass of the time-sensitive scheduler ticks: class, mentor and event reminders, the mentor publish sweep, assignment release notifications, monthly invoices and post-session tasks. It is protected by `CRON_SECRET`: send it as the `x-cron-secret` header or the `?key=` query param. Without `CRON_SECRET` set, the endpoint returns `503`.

It exists because Vercel's serverless functions have no long-lived process, so the `setInterval` schedulers started in `src/server.js` never run there. Point an external pinger (for example cron-job.org) at it every minute. Each tick is idempotent, so late or duplicate calls don't send duplicate emails. The notification-cleanup scheduler is not part of this endpoint; it runs only under `src/server.js`.

## Runtimes and deployment

The same Express app (`src/app.js`) runs in two ways:

| Runtime | Entry | Notes |
| --- | --- | --- |
| Vercel serverless | `api/index.js` | `vercel.json` routes `/v1/*`, `/health` and `/health/db` to it (30 s max duration, bundles `pyodide` and `src/services/runners`). The DB connection is lazy, made on the first request after a cold start. No in-process schedulers; use the cron endpoint. |
| Docker / EC2 | `src/server.js` | Connects to MongoDB, then starts the in-process schedulers and listens on `PORT` (5001). The `Dockerfile` builds a multi-stage, non-root, read-only-friendly image. The app writes nothing to disk. |

- `deploy/` has the EC2 scripts: `deploy-ec2.sh` (rsync, build and restart), `restart-container.sh` (runs on the host), `setup-ssl.sh` (Let's Encrypt via certbot) and `nginx-codemasti.conf`.
- `loadtest/` has a zero-dependency stress test (`stress-test.js`) and a one-command wrapper (`run-stress-test.sh`) that raises the rate limit on EC2, runs the test, restores the limit and writes an HTML report to `loadtest/reports/`.

## Further docs

- [Architecture](docs/ARCHITECTURE.md)
- [Environment variables](docs/ENV.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Runbook](docs/RUNBOOK.md)
- [AI evaluator](docs/AI_EVALUATOR.md)
