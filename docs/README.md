# Server docs

Documentation for `my-codemasti-server`. Everything here is derived from code; paths are relative to the server repo unless stated.

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System diagram, repos/ports, layering with file counts, middleware order, response envelope, auth and RBAC, runtimes, schedulers, frontends, integrations, model map |
| [ENV.md](ENV.md) | Every environment variable for server, student portal and admin panel (required, default, secret, purpose), shell-only deploy/loadtest vars, production checklist, gotchas |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel and Docker/EC2 deploys, Nginx, TLS, cron pinger, health checks, load test, rollback notes |
| [RUNBOOK.md](RUNBOOK.md) | Scheduler table, cron endpoint, rate limits, log contexts, failure modes, operator scripts, open operational items |
| [AI_EVALUATOR.md](AI_EVALUATOR.md) | Gemini/DeepSeek selection, written-answer grading flow, 4-layer prompt-injection defence, where results are stored |
| [BILLING.md](BILLING.md) | Manual UPI and PhonePe flows, `PAYMENTS_MODE`, invoice generation and discounts, monthly scheduler, webhook, refunds |
| [batches-and-enrollment.md](batches-and-enrollment.md) | `BatchCatalog`, `StudentEnrollment` as membership source, enrollment-number format, course picker, admin endpoints, edge cases |
| [SCHEMA_REDESIGN.md](SCHEMA_REDESIGN.md) | Proposal (not implemented): seats that never re-enrol, cohorts, schools, staff assignments, one audience shape, migration phases |
| [api/ROUTES.md](api/ROUTES.md) | Generated table of all 256 routes in `src/routes/modules` plus the webhook and health routes: method, full path, auth/roles, handler |
| [api/REFERRAL_ADMISSION_API_DOC.md](api/REFERRAL_ADMISSION_API_DOC.md) | `POST /v1/admin/students` contract for external admission systems, with referral rewards |
| [archive/BATCH_MULTIBATCH_MIGRATION_PLAN.md](archive/BATCH_MULTIBATCH_MIGRATION_PLAN.md) | Superseded planning doc (historical) |
| [archive/SCHEMA_AUDIT_2026-05-27.md](archive/SCHEMA_AUDIT_2026-05-27.md) | Stale schema audit snapshot (35 of 42 models) |

The workspace-level agent guide is `CLAUDE.md` (mirrored by `AGENTS.md`) in the directory above the three repos.
