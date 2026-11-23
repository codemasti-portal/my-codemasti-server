# Deployment

The server code supports two runtimes. Which repo deploys where:

| Repo | Target | Evidence |
|---|---|---|
| `my-codemasti-server` | Docker on EC2 behind Nginx (`server.codemasti.com`) **and** a Vercel serverless entry | `Dockerfile`, `deploy/*.sh`, `deploy/nginx-codemasti.conf`; `vercel.json`, `api/index.js`. Which of the two currently serves production is not provable from the repo: the admin rewrite and the deploy scripts both point at `server.codemasti.com`, and the EC2 scripts default to that domain. |
| `my-codemasti-admin` | Vercel | `vercel.json` rewrites `/v1/:path*` to `https://server.codemasti.com/v1/:path*` and falls back to `/index.html` |
| `my-codemasti-com` | **unverified** | No `vercel.json`; `next.config.mjs` has only redirects. Nothing in the repo names its host. |

Variables for every runtime: [ENV.md](ENV.md). Production safety notes (2026-11-23): `NODE_ENV=production` is set by the Docker image, `deploy/restart-container.sh` and Vercel; the server relies on it to keep OTPs out of the logs (`OTP_DEBUG_LOG`) and to print the `[SECURITY]` startup warning when `CORS_ORIGINS` is empty. On startup also watch for `[SECURITY] PAYMENTS_MODE=phonepe ...` (webhook credentials unset). `POST /v1/auth/google` returns 503 until `GOOGLE_CLIENT_ID` is set. Deploying this change needs no new env variable; existing deployments keep working (the only visible differences are: OTPs are no longer printed in logs when email sending fails, and the Google route is refused when unconfigured).

## 1. Vercel (serverless)

Files: `vercel.json`, `api/index.js`.

- Routes `/v1/(.*)`, `/health` and `/health/db` go to `api/index.js`, which `await`s a cached `connectDb()` promise and then hands the request to the Express app.
- `functions["api/index.js"]`: `maxDuration: 30` and `includeFiles: "{node_modules/pyodide,src/services/runners}/**"` (Pyodide and the Python runner script must ship in the function bundle).
- No timers run: **configure an external cron pinger** (section 3). Without it reminders, mentor publish notifications, assignment-release notifications, monthly invoices and post-session tasks never fire.
- DB connection is lazy per cold start; the same middleware also reconnects on demand.
- Set every variable from [ENV.md](ENV.md) in the Vercel project (no `.env` file is deployed). Nothing in the repo sets `TRUST_PROXY` for Vercel, and rate-limit state is in-memory per instance; how `req.ip` behaves behind Vercel's proxy is unverified.
- Cold start: Pyodide loads from disk in a few seconds (comment in `python-wasm-executor.js`); the Python execution budget is sized to stay inside `maxDuration`.
- Rollback: use Vercel's deployment history to promote a previous deployment (platform feature; not scripted in this repo).

## 2. Docker on EC2

### Image (`Dockerfile`, `.dockerignore`)
- Two stages: `deps` (`node:24.22.1-alpine3.24`, npm pinned to `12.2.1`, `npm ci --omit=dev --ignore-scripts`) and `runtime` (plain Alpine 3.24 + the copied `node` binary, `libstdc++`, `libgcc`, `tini`).
- Runs as unprivileged UID/GID `10001`; code is root-owned and read-only; `ENV NODE_ENV=production PORT=5001`; `EXPOSE 5001`; `ENTRYPOINT tini`, `CMD node src/server.js`.
- `HEALTHCHECK` every 30 s: `fetch http://127.0.0.1:$PORT/health` (so a DB outage marks the container unhealthy, because the DB middleware runs before `/health`).
- `.dockerignore` excludes `node_modules`, `.git`, `.env*` (keeps `.env.example`), `api/`, `vercel.json`, `*.md`, `deploy/`, `loadtest/`, `Dockerfile`, editor files. Only `package.json` and `src/` are copied in.
- Node/npm versions must stay in sync across `package.json` `devEngines`, `.nvmrc` and the `Dockerfile` ARGs.

### Deploy (`deploy/deploy-ec2.sh`)
```bash
./deploy/deploy-ec2.sh          # code only; server keeps ~/codemasti/.env
./deploy/deploy-ec2.sh --env    # also scp local .env to ~/codemasti/.env (chmod 600)
```
Steps: `rsync -az --delete` of the **current working tree** (excluding `node_modules`, `.git`, `.env`) to `~/codemasti/app/`; then over SSH `docker build -q -t codemasti-api:latest .`, `bash deploy/restart-container.sh`, `docker image prune -f`. Override the target with `EC2_HOST` / `EC2_KEY` (defaults are baked into the script).

### Container (`deploy/restart-container.sh`, runs on the host)
Removes any existing `codemasti-api` container and runs a new one with: `--env-file ~/codemasti/.env`, `-e NODE_ENV=production -e PORT=5001 -e TRUST_PROXY=1`, `-p 127.0.0.1:5001:5001`, `--read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m`, `--cap-drop ALL`, `--security-opt no-new-privileges`, log rotation (10 MB x 3), `--restart unless-stopped`. It then polls `localhost:5001/health` (up to 30 x 2 s) and prints `/health/db`.

### Nginx (`deploy/nginx-codemasti.conf`)
Reverse proxy `server.codemasti.com` port 80 -> `127.0.0.1:5001`; `client_max_body_size 20m`; `proxy_read_timeout 120s`; forwards `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, WebSocket upgrade headers. The header comment says it lives at `/etc/nginx/conf.d/codemasti.conf`; **no script installs it**, so installation is a manual step. Certbot later adds the 443 block to the live copy.

### TLS (`deploy/setup-ssl.sh`)
```bash
CERTBOT_EMAIL=you@example.com ./deploy/setup-ssl.sh   # DOMAIN defaults to server.codemasti.com
```
Prerequisites: DNS A record to the instance, ports 80/443 open in the security group, certbot + nginx plugin installed on the host. The script runs `certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect`, enables `certbot-renew.timer`, runs `certbot renew --dry-run`, then `curl`s `https://$DOMAIN/health`.

### Rollback (what the scripts support)
- The image is always tagged `codemasti-api:latest` and the previous image is pruned (`docker image prune -f` removes the dangling old layer), so there is no tagged previous image on the host to flip back to.
- Rollback = check out the previous good revision locally and re-run `./deploy/deploy-ec2.sh` (it deploys the working tree, not a git ref; make sure the tree is clean). Env changes are separate: edit `~/codemasti/.env` on the host, then `bash ~/codemasti/app/deploy/restart-container.sh` (env is only read at container start).
- `deploy-ec2.sh --env` overwrites the server `.env`; do not use it casually.

## 3. Cron pinger (required on Vercel; recommended on EC2)

Endpoint: `GET` or `POST https://<api-host>/v1/internal/cron/run` every minute. Auth with `CRON_SECRET` as the `x-cron-secret` header (preferred) or `?key=` (appears in logs). Responses: `200 {ran_at, results{...}}`, `401 UNAUTHORIZED`, `503 CRON_NOT_CONFIGURED` when `CRON_SECRET` is unset. Which service runs the pinger is not configured in this repo.

```bash
curl -fsS -H "x-cron-secret: $CRON_SECRET" https://server.codemasti.com/v1/internal/cron/run
```

The endpoint is also subject to the global 200 req/min/IP limiter. On EC2 the in-process timers already run six of the seven ticks; the pinger is still needed there for the post-session tasks tick (see [RUNBOOK.md](RUNBOOK.md)). Running both is safe: ticks claim work atomically.

## 4. Health checks

| URL | Meaning |
|---|---|
| `GET /health` | `200 {status:"ok"}` once the DB middleware has connected; `503 DB_NOT_CONNECTED` otherwise |
| `GET /health/db` | `200 {status:"ok",db:"up"}` after a `ping`; `503 DB_NOT_CONNECTED` / `DB_PING_FAILED` |

Used by the Docker `HEALTHCHECK`, `restart-container.sh`, and `setup-ssl.sh`.

## 5. Load test (`loadtest/`)

```bash
STUDENT_EMAIL=test@example.com STUDENT_PASSWORD='...' ./loadtest/run-stress-test.sh
```
`run-stress-test.sh` (1) raises `RATE_LIMIT_API_MAX` to 1000000 in the EC2 `.env` and restarts the container, (2) runs `node loadtest/stress-test.js`, (3) always restores the limit on exit (trap), (4) opens `loadtest/reports/<timestamp>/report.html`. `stress-test.js` (zero dependencies) logs in N virtual students, browses portal endpoints with think time, samples container CPU/memory over SSH, and writes an HTML report, JSON summary and raw CSV. Tuning variables (`USERS`, `RAMP_SEC`, `HOLD_SEC`, `THINK_*`, `LOGIN_MODE`, `TARGET_P95_MS`, `TARGET_ERROR_PCT`, `BASE_URL`, `KEEP_RATE_LIMIT`): [ENV.md](ENV.md) section 4.

Cautions: the default `BASE_URL` and `EC2_HOST` point at the live API; the script restarts the production container twice and the OTP/auth endpoints are rate-limited, so use a dedicated test student. `KEEP_RATE_LIMIT=1` skips the restart and tests with the real limiter.
