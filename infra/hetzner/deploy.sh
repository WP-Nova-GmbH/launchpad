#!/usr/bin/env bash
# Deploys the local working tree to the self-hosted relay host: rsync the
# source (respecting .gitignore, so no secrets and no node_modules travel),
# build the relay and executor images on the host, apply migrations, restart.
#
# Usage: infra/hetzner/deploy.sh [user@host]
# Defaults the host to root@<relay_public_ip> from this module's Terraform state.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

host="${1:-root@$(terraform -chdir="${script_dir}" output -raw relay_public_ip)}"

echo "deploy: rsyncing working tree to ${host}"
rsync -az --delete --delete-excluded \
  --exclude=.git \
  --filter=':- .gitignore' \
  "${repo_root}/" "${host}:/opt/launchpad/"

ssh "${host}" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/launchpad
echo "deploy: building relay image"
docker build -t launchpad-relay -f infra/relay/Dockerfile .
echo "deploy: building executor image"
docker build -t t3code-executor-dev -f infra/executor-image/Dockerfile .
docker image prune -f >/dev/null
echo "deploy: applying migrations"
launchpad-relay-migrate
echo "deploy: restarting relay"
systemctl restart launchpad-relay
for _ in $(seq 30); do
  if curl -fsS http://127.0.0.1:8610/health >/dev/null 2>&1; then
    echo "deploy: relay healthy"
    exit 0
  fi
  sleep 2
done
echo "deploy: relay did not come up; check journalctl -u launchpad-relay" >&2
exit 1
REMOTE
