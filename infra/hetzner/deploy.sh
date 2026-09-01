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

# The relay's GitHub App is operator configuration (GITHUB_APP_* in
# relay.env). When the caller — CI, from repository secrets — has it, write it
# there so nobody has to edit the host by hand. The PEM is stored on one line
# with `\n` escapes, which the relay unescapes; Docker's --env-file does not.
if [[ -n "${RELAY_GITHUB_APP_ID:-}" && -n "${RELAY_GITHUB_APP_SLUG:-}" && -n "${RELAY_GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  echo "deploy: configuring the relay's GitHub App"
  escaped_key="${RELAY_GITHUB_APP_PRIVATE_KEY//$'\n'/\\n}"
  printf 'GITHUB_APP_ID=%s\nGITHUB_APP_SLUG=%s\nGITHUB_APP_PRIVATE_KEY="%s"\n' \
    "${RELAY_GITHUB_APP_ID}" "${RELAY_GITHUB_APP_SLUG}" "${escaped_key}" |
    ssh "${host}" bash -s <<'REMOTE_ENV'
set -euo pipefail
umask 077
current=/etc/launchpad-relay/relay.env
next="$(mktemp)"
{ grep -v '^GITHUB_APP_' "${current}" 2>/dev/null || true; cat; } > "${next}"
install -m 0600 "${next}" "${current}"
rm -f "${next}"
REMOTE_ENV
fi

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

# The relay's signing key must outlive its container: enrolled machines and
# linked environments pin its public half, and a key regenerated on each
# deploy strands all of them. Boxes provisioned before cloud-init mounted the
# key directory get the mount and the path here, idempotently.
unit=/etc/systemd/system/launchpad-relay.service
install -m 0700 -d /var/lib/launchpad-relay
if ! grep -q -- '-v /var/lib/launchpad-relay:/var/lib/launchpad-relay' "${unit}"; then
  echo "deploy: mounting the persistent signing key directory into the relay"
  sed -i 's#^\(\s*\)-v /var/run/docker.sock:/var/run/docker.sock \\$#&\n\1-v /var/lib/launchpad-relay:/var/lib/launchpad-relay \\#' "${unit}"
  systemctl daemon-reload
fi
if ! grep -q '^DEV_RELAY_CLOUD_MINT_PRIVATE_KEY_PATH=' /etc/launchpad-relay/provisioned.env; then
  echo "DEV_RELAY_CLOUD_MINT_PRIVATE_KEY_PATH=/var/lib/launchpad-relay/cloud-mint-private.pem" \
    >> /etc/launchpad-relay/provisioned.env
fi
if [[ ! -f /var/lib/launchpad-relay/cloud-mint-private.pem ]] \
  && docker cp launchpad-relay:/opt/launchpad/.t3/relay-dev-cloud-mint-private.pem \
    /var/lib/launchpad-relay/cloud-mint-private.pem 2>/dev/null; then
  echo "deploy: kept the running relay's signing key"
fi
chmod 600 /var/lib/launchpad-relay/cloud-mint-private.pem 2>/dev/null || true

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
