# CodeMasti Backend (Express + MongoDB)

Backend scaffold for the CodeMasti frontend handoff contract.

## Cross-repo docs

- [Announcements — instructor phases](../docs/ANNOUNCEMENTS_INSTRUCTOR_PHASES.md) — phased API/UI work (instructor batch-scoped publish, student visibility)

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose
- Zod request validation
- JWT auth (access + refresh token pattern)
- Rate limiting (`/auth/otp/*` protected)

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

These versions are enforced via `devEngines` in `package.json` — `npm install` fails with `EBADDEVENGINES` on any other Node/npm version.
2. Copy env file:

```bash
cp .env.example .env
```

3. Update `.env` values (especially JWT secrets and Mongo URI).

4. Install and run:

```bash
npm install
npm run dev
```

Server default: `http://localhost:5001`

## Implemented Base URL

All APIs are under:

`/v1`

Example:

- `GET /v1/auth/me`
- `GET /v1/students/me`

## Response Contract

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

## Phase-1 Routes Scaffolded

- Auth: OTP send/verify, Google login, refresh, logout, me
- Students: me, update me
- Dashboard: summary
- Announcements: list
- Notes: list/detail/download
- Assignments: list/detail/run/submit/submissions
- Arena: list/detail/run/submit/submissions

## Notes

- Current controllers return starter/mock data with contract-compatible payloads.
- Replace controller internals with DB-backed services incrementally.
- Hidden test cases are intentionally not exposed in question detail endpoints.
