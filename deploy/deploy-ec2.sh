#!/usr/bin/env bash
# Build and (re)start the CodeMasti API on EC2.
# Usage: ./deploy/deploy-ec2.sh            (code only; server keeps its existing .env)
#        ./deploy/deploy-ec2.sh --env      (also upload local .env to the server)
set -euo pipefail

HOST="${EC2_HOST:-ec2-user@ec2-3-26-161-229.ap-southeast-2.compute.amazonaws.com}"
KEY="${EC2_KEY:-$HOME/Downloads/server-ssh.pem}"
SSH=(ssh -i "$KEY" "$HOST")

cd "$(dirname "$0")/.."

echo "→ Syncing source to $HOST"
rsync -az --delete -e "ssh -i $KEY" \
  --exclude node_modules --exclude .git --exclude .env \
  ./ "$HOST:~/codemasti/app/"

if [[ "${1:-}" == "--env" ]]; then
  echo "→ Uploading .env"
  scp -q -i "$KEY" .env "$HOST:~/codemasti/.env"
  "${SSH[@]}" 'chmod 600 ~/codemasti/.env'
fi

echo "→ Building image and restarting container"
"${SSH[@]}" 'set -e
cd ~/codemasti/app
sudo docker build -q -t codemasti-api:latest .
bash deploy/restart-container.sh
sudo docker image prune -f >/dev/null'
echo "✓ Deployed"
