#!/usr/bin/env bash
# Called from the Launchpad checkout by deploy-beta.sh.
set -euo pipefail

source infra/beta/local-docker.sh

die() {
  printf 'Beta E2B: %s\n' "$*" >&2
  exit 1
}

firewall_file() {
  local action=$1 source=$2 target=$3 mode=$4
  [[ "$(sudo -n realpath -m -- "$target")" == "$target" ]] ||
    die "Keep the existing firewall path $target and resolve it before deployment."
  if sudo -n test -e "$target"; then
    sudo -n test -f "$target" &&
      [[ "$(sudo -n stat -c '%u:%g:%a:%h' "$target")" == "0:0:${mode#0}:1" ]] &&
      sudo -n cmp -s "$source" "$target" ||
      die "Keep the existing firewall file $target and reconcile it before deployment."
  elif [[ "$action" == install ]]; then
    sudo -n install -D -o root -g root -m "$mode" -- "$source" "$target"
  fi
}

firewall_files() {
  firewall_file "$1" infra/e2b/host-firewall.nft /etc/launchpad/host-firewall.nft 0644
  firewall_file "$1" infra/e2b/host-firewall.py /usr/local/libexec/launchpad-host-firewall 0755
  firewall_file "$1" infra/e2b/launchpad-thread-vm-firewall.service \
    /etc/systemd/system/launchpad-thread-vm-firewall.service 0644
}

runtime_dir=${E2B_RUNTIME_DIR:?Set E2B_RUNTIME_DIR to the stock runtime directory}
[[ "$runtime_dir" == /* && "$(realpath -m -- "$runtime_dir")" == "$runtime_dir" ]] ||
  die "Use a canonical absolute E2B runtime directory."

owner=/var/lib/e2b/launchpad-stock-runtime-owner
orchestrator=/var/lib/e2b/bin/orchestrator

root_path_exists() {
  sudo -n test -e "$1" || sudo -n test -L "$1"
}

has_build_receipt() {
  sudo -n test -f "$runtime_dir/build.json" &&
    sudo -n jq -e 'type == "object"' "$runtime_dir/build.json" >/dev/null 2>&1
}

incomplete_build() {
  if sudo -n test -d "$runtime_dir" && ! root_path_exists "$owner" && ! root_path_exists "$orchestrator"; then
    printf 'Beta E2B: Inspect the incomplete stock build at %s. Once no build is running, preserve it with:\n' "$runtime_dir" >&2
    printf '  sudo mv -nT -- %q %q\n' "$runtime_dir" "$runtime_dir.incomplete.$(date -u +%Y%m%dT%H%M%SZ)" >&2
    die 'Fix the cause of the failed build, then rerun the same deployment command.'
  fi
  die "Incomplete stock build at $runtime_dir. Verify the existing host installation before retrying."
}

sudo -v
require_local_docker
firewall_files check
unit_path="$(systemctl show -p FragmentPath --value launchpad-thread-vm-firewall.service)"
[[ -z "$unit_path" || "$unit_path" == /etc/systemd/system/launchpad-thread-vm-firewall.service ]] ||
  die "Keep the firewall unit at $unit_path and reconcile it before deployment."
if sudo -n nft list table inet launchpad_thread_vm >/dev/null 2>&1; then
  sudo -n /usr/local/libexec/launchpad-host-firewall check ||
    die "Keep the existing Launchpad firewall table and verify its ownership before deployment."
fi

if ! root_path_exists "$runtime_dir"; then
  for installed in "$owner" "$orchestrator"; do
    if root_path_exists "$installed"; then
      die "Existing E2B host installation found. Use its verified runtime directory."
    fi
  done
  if ! sudo -n python3 infra/e2b/build-stock-runtime.py "$runtime_dir" \
    --arch amd64 --postgres-host-port 5434; then
    sudo -v
    if root_path_exists "$runtime_dir" && ! has_build_receipt; then
      incomplete_build
    fi
    die 'Stock E2B build failed. Fix the error above and rerun the same deployment command.'
  fi
fi

sudo -v
has_build_receipt || incomplete_build
sudo -n python3 - "$runtime_dir" <<'PY'
import json
from pathlib import Path
import runpy
import sys
from urllib.parse import urlsplit

stock = runpy.run_path("infra/e2b/verify-stock-runtime.py")

try:
    directory, receipt = stock["load"](sys.argv[1])
    compose = stock["compose"](directory, receipt)
    configuration = json.loads(stock["run"](*compose, "--profile", "*", "config", "--format", "json"))
    stock["verify_configuration"](receipt, configuration)
    host_state = Path("/var/lib/e2b")
    try:
        host_state.lstat()
    except FileNotFoundError:
        # The first stock host setup creates this directory before a collector can use it.
        if host_state.parent.resolve(strict=True) != host_state.parent or not host_state.parent.is_dir():
            raise ValueError("The E2B host state parent must be a canonical directory.")
    else:
        stock["verify_maintenance"](directory, receipt)
    running = stock["verify_exclusive_host"](receipt, configuration)

    services = configuration["services"]
    bindings = services["postgres"].get("ports", [])
    if len(bindings) != 1 or (
        bindings[0]["host_ip"], str(bindings[0]["published"]), bindings[0]["target"], bindings[0]["protocol"]
    ) != ("127.0.0.1", "5434", 5432, "tcp"):
        raise ValueError("Expected the E2B PostgreSQL mapping 127.0.0.1:5434:5432.")
    for service in ("api", "dashboard-api"):
        database = urlsplit(services[service]["environment"]["POSTGRES_CONNECTION_STRING"])
        if (database.hostname, database.port) != ("127.0.0.1", 5434):
            raise ValueError("Expected E2B API services to use PostgreSQL on 127.0.0.1:5434.")

    owner = host_state / "launchpad-stock-runtime-owner"
    binary = host_state / "bin/orchestrator"
    expected_owner = f"{receipt['composeProject']}:{receipt['sourceCommit']}:{receipt['orchestratorSha256']}"
    if owner.is_symlink() or (owner.exists() and (not owner.is_file() or owner.read_text().strip() != expected_owner)):
        raise ValueError("The E2B host belongs to a different deployment.")
    if binary.exists() or binary.is_symlink():
        stock["root_file"](owner)
        stock["root_file"](binary)
        if stock["sha"](binary) != receipt["orchestratorSha256"]:
            raise ValueError("The installed orchestrator differs from the selected deployment.")
    else:
        if running:
            raise ValueError("The E2B orchestrator is running without its installed binary.")
        # Published ports plus the host-network ports of the pinned services started by start:vm-host.
        ports = {3000, 3002, 3003, 3010, 5007, 5008, 5009, 5016, 5017, 5018, 5109, 6060, 6061}
        for service in ("postgres", "redis", "clickhouse", "vector"):
            ports.update(int(binding["published"]) for binding in services[service]["ports"])
        listeners = stock["run"]("ss", "-H", "-ltn")
        used = {int(line.split()[3].rsplit(":", 1)[1]) for line in listeners.splitlines() if line.strip()}
        if collisions := sorted(ports & used):
            raise ValueError(f"Ports required by E2B are already in use: {', '.join(map(str, collisions))}.")
        for service in ("preflight", "host-setup", "fetch-artifacts"):
            print(f"Preparing stock E2B ({service})", flush=True)
            try:
                stock["run"](*compose, "run", "--rm", "--no-deps", service)
            except ValueError as error:
                raise ValueError(f"Stock E2B {service} failed. Inspect the selected deployment.") from error
except (OSError, KeyError, TypeError, ValueError) as error:
    sys.exit(f"Beta E2B: {error}")
PY

sudo -v
firewall_files install
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now launchpad-thread-vm-firewall.service

E2B_RUNTIME_DIR="$runtime_dir" vp run start:vm-host
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null
