#!/usr/bin/env bash
# Issue a Let's Encrypt certificate for the API domain on EC2 and enable HTTPS + auto-renewal.
# Prerequisites: DNS A record for $DOMAIN → EC2 public IP, and ports 80/443 open in the Security Group.
# Usage: CERTBOT_EMAIL=you@example.com ./deploy/setup-ssl.sh   (email gets Let's Encrypt expiry notices)
set -euo pipefail

HOST="${EC2_HOST:-ec2-user@52.66.148.107}"
KEY="${EC2_KEY:-$HOME/Downloads/mumbai-server-ssh.pem}"
DOMAIN="${DOMAIN:-server.codemasti.com}"
EMAIL="${CERTBOT_EMAIL:?Set CERTBOT_EMAIL for Lets Encrypt expiry notices}"

ssh -i "$KEY" "$HOST" "set -e
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect
sudo systemctl enable --now certbot-renew.timer
sudo certbot renew --dry-run
"
curl -sf "https://$DOMAIN/health" && echo && echo "✓ HTTPS live at https://$DOMAIN"
