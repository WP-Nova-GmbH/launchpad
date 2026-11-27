#!/usr/bin/env bash
# Run on the relay host before its service replaces the old container.
set -euo pipefail
root=/var/lib/launchpad-relay/thread-artifacts
install -m 0700 -d "${root}"
systemctl stop launchpad-relay
if docker inspect launchpad-relay >/dev/null 2>&1; then
  source_root="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' launchpad-relay | sed -n 's/^DEV_RELAY_ARTIFACT_ROOT=//p' | tail -1)"
  source_root="${source_root:-/opt/launchpad/.t3/relay-artifacts}"
  if [[ "${source_root}" != "${root}" ]]; then
    staging="$(mktemp -d /var/lib/launchpad-relay/artifact-move.XXXXXX)"
    # A missing old directory is valid only when the catalog needs no objects;
    # the verification below distinguishes this from silently losing history.
    docker cp "launchpad-relay:${source_root}/." "${staging}/" 2>/dev/null || true
    find "${staging}" -maxdepth 1 -type f -name '????????-????-????-????-????????????' -exec cp -n '{}' "${root}/" \;
    chmod 600 "${root}"/* 2>/dev/null || true
  fi
fi
catalog="$(mktemp /var/lib/launchpad-relay/artifact-catalog.XXXXXX)"
sudo -u postgres psql -d launchpad_relay -At -F ' ' -v ON_ERROR_STOP=1 \
  -c "SELECT artifact_id,sha256,size_bytes FROM relay_thread_artifacts WHERE state='complete'" > "${catalog}"
while read -r artifact digest size; do
  file="${root}/${artifact}"
  if [[ ! -f "${file}" || "$(wc -c < "${file}" | tr -d ' ')" != "${size}" || "$(sha256sum "${file}" | cut -d ' ' -f 1)" != "${digest}" ]]; then
    echo "deploy: artifact ${artifact} is missing or corrupt; preserving the old container for recovery" >&2
    exit 1
  fi
done < "${catalog}"
rm "${catalog}"
if [[ -n "${staging:-}" ]]; then rm -r "${staging}"; fi
env_file=/etc/launchpad-relay/provisioned.env
sed -i '/^DEV_RELAY_ARTIFACT_ROOT=/d' "${env_file}"
printf 'DEV_RELAY_ARTIFACT_ROOT=%s\n' "${root}" >> "${env_file}"
