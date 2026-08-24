#!/usr/bin/env bash
#
# Bootstraps a freshly provisioned machine (ADR-0002) into a running Launchpad
# executor. The Hetzner compute driver's cloud-init writes the enrollment env
# file and pipes this script through bash; it installs Node, clones the
# source, and starts the server as a systemd service. The server then enrolls
# itself with the relay using the seeded credential and never needs this
# script again.
#
# Runs as root on a fresh Ubuntu image. Idempotent enough to re-run by hand
# from /var/log/t3code-bootstrap.log's command if a transient step failed.
set -euo pipefail

ENROLLMENT_ENV_FILE="/etc/t3code/machine-enrollment.env"
INSTALL_DIR="/opt/t3code"
SERVICE_NAME="t3code-machine"
SERVER_PORT="${T3CODE_MACHINE_SERVER_PORT:-4483}"

if [[ ! -f "${ENROLLMENT_ENV_FILE}" ]]; then
  echo "machine-bootstrap: ${ENROLLMENT_ENV_FILE} is missing; nothing to enroll" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${ENROLLMENT_ENV_FILE}"

if [[ -z "${T3CODE_MACHINE_SOURCE_GIT_URL:-}" ]]; then
  echo "machine-bootstrap: T3CODE_MACHINE_SOURCE_GIT_URL is not set" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "machine-bootstrap: installing Node.js and git"
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git
corepack enable

if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  echo "machine-bootstrap: cloning ${T3CODE_MACHINE_SOURCE_GIT_URL}"
  git clone --depth 1 "${T3CODE_MACHINE_SOURCE_GIT_URL}" "${INSTALL_DIR}"
fi

echo "machine-bootstrap: installing dependencies"
cd "${INSTALL_DIR}"
corepack install
pnpm install --frozen-lockfile

echo "machine-bootstrap: installing the ${SERVICE_NAME} service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Launchpad executor server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
# The enrollment env file is scrubbed by the server after the seed is
# consumed; '-' keeps later boots working once it is gone.
EnvironmentFile=-${ENROLLMENT_ENV_FILE}
ExecStart=/usr/bin/node apps/server/src/bin.ts serve --port ${SERVER_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
echo "machine-bootstrap: done; the server enrolls itself on startup"
