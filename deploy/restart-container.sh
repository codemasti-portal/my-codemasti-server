#!/usr/bin/env bash
# Runs ON the EC2 host: (re)create the API container from the current image and ~/codemasti/.env.
# Used by deploy/deploy-ec2.sh and loadtest/run-stress-test.sh.
set -euo pipefail

# Least privilege at runtime: read-only root filesystem (only /tmp is writable),
# no Linux capabilities, no privilege escalation via setuid binaries. The app is stateless
# (uploads go to Cloudinary), so no volume is mounted.
sudo docker rm -f codemasti-api >/dev/null 2>&1 || true
sudo docker run -d --name codemasti-api --restart unless-stopped \
  --env-file ~/codemasti/.env -e NODE_ENV=production -e PORT=5001 -e TRUST_PROXY=1 \
  -p 127.0.0.1:5001:5001 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  --log-opt max-size=10m --log-opt max-file=3 \
  codemasti-api:latest >/dev/null

for _ in $(seq 1 30); do curl -sf localhost:5001/health >/dev/null && break; sleep 2; done
curl -s localhost:5001/health/db; echo
