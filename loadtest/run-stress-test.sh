#!/usr/bin/env bash
# One-command stress test against the EC2 deployment.
#   1. temporarily raises the API rate limit on EC2 (all load comes from this one IP)
#   2. runs loadtest/stress-test.js (samples server CPU/memory over SSH)
#   3. restores the normal rate limit — always, even on Ctrl+C or failure
#   4. opens the HTML report
#
# Usage:
#   STUDENT_EMAIL=test@example.com STUDENT_PASSWORD='secret' ./loadtest/run-stress-test.sh
#
# Optional env: USERS=500 RAMP_SEC=60 HOLD_SEC=180 THINK_MIN_MS=2000 THINK_MAX_MS=5000
#               LOGIN_MODE=each|shared  TARGET_P95_MS=1000  TARGET_ERROR_PCT=1
#               KEEP_RATE_LIMIT=1 (test with the real 200 req/min limiter)
set -euo pipefail

HOST="${EC2_HOST:-ec2-user@ec2-3-26-161-229.ap-southeast-2.compute.amazonaws.com}"
KEY="${EC2_KEY:-$HOME/Downloads/server-ssh.pem}"
: "${STUDENT_EMAIL:?Set STUDENT_EMAIL to a test student account}"
: "${STUDENT_PASSWORD:?Set STUDENT_PASSWORD for that account}"

cd "$(dirname "$0")/.."

# 500 users need far more sockets than macOS's default 256 open files.
ulimit -n 10240 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true

set_remote_limit() { # $1 = value, or empty to remove the override
  ssh -i "$KEY" -o BatchMode=yes "$HOST" "set -e; cd ~/codemasti
    sed -i '/^RATE_LIMIT_API_MAX=/d' .env
    ${1:+echo RATE_LIMIT_API_MAX=$1 >> .env}
    bash ~/codemasti/app/deploy/restart-container.sh >/dev/null"
}

if [[ "${KEEP_RATE_LIMIT:-}" != "1" ]]; then
  echo "→ Raising API rate limit on EC2 for the test (container restarts, ~5s)"
  set_remote_limit 1000000
  trap 'echo "→ Restoring normal API rate limit on EC2"; set_remote_limit ""' EXIT
fi

export SSH_KEY="$KEY" SSH_HOST="$HOST"
OUT_DIR="${OUT_DIR:-loadtest/reports/$(date +%Y-%m-%d_%H-%M-%S)}"
export OUT_DIR

node loadtest/stress-test.js || true

if [[ -f "$OUT_DIR/report.html" ]] && command -v open >/dev/null; then
  open "$OUT_DIR/report.html"
fi
