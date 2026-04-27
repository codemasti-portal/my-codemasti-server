# CodeMasti Backend (Express + MongoDB)

Backend scaffold for the CodeMasti frontend handoff contract.

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose
- Zod request validation
- JWT auth (access + refresh token pattern)
- Rate limiting (`/auth/otp/*` protected)

## Setup

1. Copy env file:

```bash
cp .env.example .env
```

2. Update `.env` values (especially JWT secrets and Mongo URI).

3. Install and run:

```bash
npm install
npm run dev
```

Server default: `http://localhost:5000`

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
