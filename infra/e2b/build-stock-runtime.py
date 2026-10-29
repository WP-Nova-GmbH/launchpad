#!/usr/bin/env python3
"""Prepare a new stock E2B deployment for the snapshot collector; start no services."""

import argparse
import datetime
import hashlib
import json
import platform
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path


INSTALLER = r'''#!/usr/bin/env bash
set -euo pipefail
fail() { echo "stock-runtime: $*" >&2; exit 1; }
action="${1:-install}"
case "$action" in install|preflight|setup) ;; *) fail "unknown installer action" ;; esac
root="${HOST_ROOT:-/host}"
state="$root/var/lib/e2b"
owner="$state/launchpad-stock-runtime-owner"
binary="$state/bin/orchestrator"
[ -n "${STOCK_RUNTIME_OWNER:-}" ] || fail "deployment ownership is missing"
[[ "${STOCK_ORCHESTRATOR_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || fail "invalid orchestrator checksum"
owner_key=$(printf '%s' "$STOCK_RUNTIME_OWNER" | sha256sum | awk '{print $1}')
owner_pending="$state/.stock-runtime-owner-$owner_key.pending"
source_pending="$state/bin/.stock-runtime-orchestrator.pending"
cleanup_owner=""
cleanup_source=""
cleanup() {
  [ -z "$cleanup_owner" ] || rm -f -- "$cleanup_owner"
  [ -z "$cleanup_source" ] || rm -f -- "$cleanup_source"
  return 0
}
trap cleanup EXIT

root_file() {
  [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -Lc '%u:%h' -- "$1")" = "0:${2:-1}" ] ||
    fail "expected a root-owned regular file with ${2:-1} link(s): $1"
}

acquire_host_lock() {
  local lock="$root/run/lock/launchpad-e2b-snapshot-collector.lock" fd
  # This is the collector's host inode. Never unlink, replace or truncate it.
  [ "$(realpath -e -- "$root/run/lock")" = "$root/run/lock" ] || fail "the host lock directory must use a canonical path"
  if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
    (umask 077; set -C; : > "$lock") 2>/dev/null || [ -e "$lock" ] || fail "cannot create the host maintenance lock"
  fi
  root_file "$lock"
  [ "$(stat -Lc '%a' -- "$lock")" = 600 ] || fail "the host maintenance lock must have mode 0600"
  exec 9<> "$lock" || fail "cannot open the host maintenance lock"
  fd=/proc/self/fd/9
  [ -f "$fd" ] && [ "$(stat -Lc '%u:%a:%h' -- "$fd")" = 0:600:1 ] || fail "unsafe host maintenance lock descriptor"
  [ ! -L "$lock" ] && [ "$(stat -Lc '%d:%i' -- "$lock")" = "$(stat -Lc '%d:%i' -- "$fd")" ] ||
    fail "the host maintenance lock changed while opening it"
  # FD 9 is inherited by fetch/nsenter and their children. Closing the last
  # descriptor releases the lock, including when this wrapper is interrupted.
  flock -n 9 || fail "native E2B maintenance or staging is already active; retry after it finishes"
}

require_completed_maintenance() {
  local receipt="$state/snapshot-collection.jsonl.maintenance.json"
  [ -e "$receipt" ] || [ -L "$receipt" ] || return 0
  root_file "$receipt"
  [ "$(stat -Lc '%a' -- "$receipt")" = 600 ] && [ "$(stat -Lc '%s' -- "$receipt")" -le 65536 ] ||
    fail "unsafe snapshot maintenance receipt; recover with the snapshot collector --apply before setup"
  # Match the collector's complete receipt, not just a caller-supplied phase.
  # An abandoned Docker stop can outlive its collector process and flock.
  jq -es --arg project "${STOCK_RUNTIME_OWNER%%:*}" '
    def id: type == "string" and test("^[a-f0-9]{64}$");
    def keys_are($names): type == "object" and (keys == ($names | sort));
    length == 1 and (.[0] |
    keys_are(["schemaVersion","identity","phase","deployment","attemptedStopIds"])
    and .schemaVersion == 1 and .phase == "restored"
    and .identity == {project:$project,storagePath:"/var/lib/e2b/storage/templates",
      buildCachePath:"/var/lib/e2b/storage/build-cache",orchestratorAddress:"127.0.0.1:5008"}
    and (.deployment | keys_are(["Writers","Orchestrator","Database","Roles"]))
    and (.deployment as $d |
      ($d.Writers | type == "array" and length > 0 and all(.[]; id))
      and ($d.Orchestrator | id) and ($d.Database | id)
      and (($d.Writers + [$d.Orchestrator,$d.Database]) as $ids |
        ($ids | length) == ($ids | unique | length)
        and ($d.Roles | type == "object" and keys == ($ids | sort)))
      and $d.Roles[$d.Orchestrator] == "orchestrator" and $d.Roles[$d.Database] == "postgres"
      and ([$d.Writers[] | $d.Roles[.]] as $roles |
        all($roles[]; . == "api" or . == "dashboard-api" or . == "client-proxy")
        and ($roles | index("api")) != null and ($roles | length) == ($roles | unique | length))
      and (.attemptedStopIds | type == "array")
      and (.attemptedStopIds as $stops |
        ($stops | length) == ($stops | unique | length)
        and all($stops[]; . as $id | ($d.Writers + [$d.Orchestrator] | index($id)) != null)
        and (($stops | index($d.Orchestrator)) == null or all($d.Writers[]; . as $id | ($stops | index($id)) != null)))))
  ' "$receipt" >/dev/null 2>&1 ||
    fail "snapshot maintenance is unfinished or unverified; recover with the snapshot collector --apply before setup"
}

idle_host() {
  local comm name events inventory
  for comm in /proc/[0-9]*/comm; do
    if ! name=$(cat "$comm" 2>/dev/null); then
      [ ! -e "$comm" ] && continue
      fail "cannot inspect host processes"
    fi
    case "$name" in
      orchestrator|firecracker|template-manager|template-manage)
        fail "native E2B execution is active; this installer requires a stopped, dedicated host" ;;
    esac
  done
  if [ -d /sys/fs/cgroup/e2b ]; then
    inventory=$(mktemp)
    find /sys/fs/cgroup/e2b -name cgroup.events -print0 > "$inventory" || {
      rm -f "$inventory"; fail "cannot inspect native E2B cgroups";
    }
    while IFS= read -r -d '' events; do
      name=$(cat "$events") || { rm -f "$inventory"; fail "cannot read native E2B cgroup state"; }
      case $'\n'"$name"$'\n' in
        *$'\npopulated 1\n'*) rm -f "$inventory"; fail "native E2B cgroups are populated" ;;
      esac
    done < "$inventory"
    rm -f "$inventory"
  fi
}

check_installation() {
  local directory contents pending links
  idle_host
  for directory in "$state" "$state/bin" "$state/storage" "$state/storage/templates" "$state/storage/build-cache"; do
    [ ! -L "$directory" ] || fail "native E2B directories must not be symlinks"
    [ ! -e "$directory" ] || [ -d "$directory" ] || fail "native E2B state must use directories"
  done
  new_install=0
  if [ -e "$owner" ] || [ -L "$owner" ]; then
    [ -f "$owner" ] && [ ! -L "$owner" ] && [ "$(cat "$owner")" = "$STOCK_RUNTIME_OWNER" ] ||
      fail "this native E2B installation belongs to another deployment"
    links=$(stat -Lc '%h' -- "$owner")
    if [ "$links" = 2 ] && [ "$owner" -ef "$owner_pending" ]; then
      # A crash after the no-clobber link may retain its known staging alias.
      root_file "$owner" 2
      root_file "$owner_pending" 2
    else
      root_file "$owner"
    fi
  else
    new_install=1
    [ ! -e "$binary" ] && [ ! -L "$binary" ] || fail "an existing native E2B installation requires a separate migration"
    [ ! -e "$source_pending" ] && [ ! -L "$source_pending" ] || fail "unowned native source staging requires operator review"
    for pending in "$state"/.stock-runtime-owner-*.pending; do
      [ -e "$pending" ] || [ -L "$pending" ] || continue
      [ "$pending" = "$owner_pending" ] || fail "another deployment has an unfinished native E2B claim"
    done
    for directory in "$state/storage/templates" "$state/storage/build-cache"; do
      if [ -d "$directory" ]; then
        contents=$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit) || fail "cannot inspect native storage"
        [ -z "$contents" ] || fail "existing native E2B storage requires a separate migration"
      fi
    done
  fi
  if [ -e "$owner_pending" ] || [ -L "$owner_pending" ]; then
    if [ -e "$owner" ] && [ "$owner" -ef "$owner_pending" ]; then
      root_file "$owner_pending" 2
    else
      root_file "$owner_pending"
    fi
    [ "$(stat -Lc '%a' -- "$owner_pending")" = 600 ] || fail "unsafe native ownership staging mode"
  fi
  if [ -e "$binary" ] || [ -L "$binary" ]; then root_file "$binary"; fi
}

claim_installation() {
  if [ "$new_install" = 1 ]; then
    mkdir -p -- "$state"
    cleanup_owner="$owner_pending"
    (umask 077; printf '%s\n' "$STOCK_RUNTIME_OWNER" > "$owner_pending")
    sync -f "$owner_pending"
    ln -T -- "$owner_pending" "$owner" || fail "native E2B ownership was claimed by another deployment"
    sync -f "$state"
  fi
  if [ -e "$owner_pending" ]; then
    cleanup_owner="$owner_pending"
    rm -f -- "$owner_pending"
    sync -f "$state"
    cleanup_owner=""
  fi
}

prepare_artifacts() {
  local variable value
  # Source the pinned helpers without running their released-orchestrator main.
  FA_NO_MAIN=1 source /opt/e2b/scripts/fetch-artifacts.sh
  artifact_arch=$(goarch "$FA_ARCH") || fail "unsupported native artifact architecture: $FA_ARCH"
  for variable in E2B_ENVD_VERSION E2B_FIRECRACKER_VERSION E2B_KERNEL_VERSION E2B_BUSYBOX_VERSION; do
    value="${!variable:-}"
    [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$ ]] || fail "$variable must name one artifact version"
  done
  printf '%s  %s\n' "$STOCK_ORCHESTRATOR_SHA256" /stock/orchestrator | sha256sum -c -
}

stage_artifacts() {
  local seg=""
  [ "$artifact_arch" = amd64 ] || seg="$artifact_arch/"
  fetch "envd/${E2B_ENVD_VERSION}/${seg}envd" "$root/fc-envd/envd" 0755
  fetch "firecrackers/${E2B_FIRECRACKER_VERSION}/${artifact_arch}/firecracker" "$root/fc-versions/${E2B_FIRECRACKER_VERSION}/${artifact_arch}/firecracker" 0755
  fetch "kernels/${E2B_KERNEL_VERSION}/${artifact_arch}/vmlinux.bin" "$root/fc-kernels/${E2B_KERNEL_VERSION}/${artifact_arch}/vmlinux.bin" 0644
  fetch "busybox/${E2B_BUSYBOX_VERSION}/${artifact_arch}/busybox" "$root/fc-busybox/${E2B_BUSYBOX_VERSION}/${artifact_arch}/busybox" 0755
}

publish_orchestrator() {
  if [ -e "$source_pending" ] || [ -L "$source_pending" ]; then root_file "$source_pending"; fi
  cleanup_source="$source_pending"
  install -m 0755 /stock/orchestrator "$source_pending"
  printf '%s  %s\n' "$STOCK_ORCHESTRATOR_SHA256" "$source_pending" | sha256sum -c -
  sync -f "$source_pending"
  mv -fT -- "$source_pending" "$binary"
  cleanup_source=""
  sync -f "$state/bin"
}

# Preflight is advisory; every mutable phase rechecks under the host lock.
if [ "$action" = preflight ]; then
  check_installation
  exec nsenter -t 1 -m -u -i -n -p -- /bin/bash -s < /opt/e2b/scripts/preflight.sh
fi
prepare_artifacts
acquire_host_lock
check_installation
require_completed_maintenance
claim_installation
if [ "$action" = setup ]; then
  nsenter -t 1 -m -u -i -n -p -- /bin/bash -s < /opt/e2b/scripts/host-setup.sh
else
  stage_artifacts
  idle_host
  publish_orchestrator
fi
'''


def sha256(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def run(*args):
    subprocess.run(args, check=True)


def compose_path(path):
    return str(path).replace("$", "$$")


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def build(output, arch, lock=None):
    if arch not in ("arm64", "amd64"):
        raise ValueError("Stock runtime target must be Linux arm64 or amd64")
    lock = lock or json.loads(Path(__file__).with_name("stock-runtime.lock.json").read_text())
    if lock["schemaVersion"] != 1:
        raise ValueError("Unsupported stock runtime lock")
    source_lock = lock["source"]
    version = lock.get("orchestratorBuildVersion", "")
    # Native placement compares the timestamp patch number for feature support.
    if not isinstance(version, str):
        raise ValueError("Stock orchestrator version must be a native release stamp")
    match = re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([0-9]{12})-stock\.([a-f0-9]{12})", version)
    try:
        timestamp = datetime.datetime.strptime(source_lock.get("commitTimestamp", ""), "%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        raise ValueError("Stock source needs its verified UTC commit timestamp") from None
    if not match or match[3] != timestamp.strftime("%Y%m%d%H%M") or match[4] != source_lock["commit"][:12]:
        raise ValueError("Stock orchestrator version must match its source commit and timestamp")
    output = Path(output).absolute()
    if output.resolve() != output or any(char in str(output) for char in "\x00\r\n,"):
        raise ValueError("Choose a canonical output path without symlinks, commas or line breaks")
    output.mkdir(parents=True, exist_ok=False)
    archive = output / "source.tar.gz"
    run("curl", "--fail", "--location", "--retry", "3", "--max-filesize", str(50 << 20),
        "--output", str(archive), source_lock["archiveUrl"])
    if archive.stat().st_size > 50 << 20 or sha256(archive) != source_lock["archiveSha256"]:
        raise ValueError("Stock source archive checksum or size mismatch")
    with tarfile.open(archive) as source_tar:
        source_tar.extractall(output / "source", filter="data")
    source = output / "source" / source_lock["archiveDirectory"]
    embed = source / "embed/compose"
    packages = source / "packages"
    commit = source_lock["commit"]
    release = re.search(r'var Version = "([0-9]+)\.([0-9]+)\.[0-9]+"',
                        (packages / "orchestrator/pkg/version/main.go").read_text())
    if not release or release.groups() != match.groups()[:2]:
        raise ValueError("Stock orchestrator version differs from the native release line")
    migration = max(path.name.split("_", 1)[0] for path in (packages / "db/migrations").glob("*.sql"))
    if not re.fullmatch(r"[0-9]{14}", migration):
        raise ValueError("Cannot determine the stock database migration")
    suffix = commit[:12] + "-" + hashlib.sha256(str(output).encode()).hexdigest()[:12]
    project = "launchpad-e2b-stock-" + hashlib.sha256(str(output).encode()).hexdigest()[:16]
    images = {}
    for role, package in [("api", "api"), ("db-migrator", "db"), ("client-proxy", "client-proxy"),
                          ("dashboard-api", "dashboard-api"), ("tools", None), ("node-e2b", None)]:
        dockerfile = packages / package / "Dockerfile" if package else embed / ("docker/" + role + ".Dockerfile")
        iid = output / (role + ".image-id")
        tag = "launchpad-e2b-stock-" + role + ":" + suffix
        run("docker", "build", "--platform", "linux/" + arch, "--file", str(dockerfile),
            "--build-arg", "COMMIT_SHA=" + commit, "--build-arg", "VERSION=stock-" + commit[:12],
            "--build-arg", "EXPECTED_MIGRATION_TIMESTAMP=" + migration,
            "--label", "org.opencontainers.image.revision=" + commit,
            "--tag", tag, "--iidfile", str(iid), str(packages if package else embed))
        image_id = iid.read_text().strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise ValueError("Docker did not return an immutable image ID")
        images[role] = {"tag": tag, "id": image_id}
    artifacts = output / "artifacts"
    run("docker", "build", "--platform", "linux/" + arch, "--target", "artifacts",
        "--file", str(packages / "orchestrator/Dockerfile"),
        "--build-arg", "COMMIT_SHA=" + commit, "--build-arg", "VERSION=" + version,
        "--output", "type=local,dest=" + str(artifacts), str(packages))
    orchestrator = artifacts / "orchestrator"
    orchestrator.chmod(0o755)
    digest = sha256(orchestrator)
    (artifacts / "install-orchestrator.sh").write_text(INSTALLER)
    shutil.copyfile(embed / "compose.yaml", output / "compose.yaml")
    # The tools image binds the actual launcher and fetch scripts to this source.
    defaults = (embed / ".env").read_text()
    for role, variable in (("tools", "E2B_TOOLS_IMAGE"), ("node-e2b", "E2B_NODE_E2B_IMAGE")):
        defaults, count = re.subn(r"^" + variable + r"=.*$", variable + "=" + images[role]["id"], defaults, flags=re.M)
        if count != 1:
            raise ValueError("Stock Compose " + role + " image setting is missing")
    # Native layer uploads can overlap the next 4 GiB runner VM's restore.
    defaults, hugepage_settings = re.subn(r"^HUGEPAGES=.*$", "HUGEPAGES=4096", defaults, flags=re.M)
    if hugepage_settings > 1:
        raise ValueError("Stock Compose hugepage setting is ambiguous")
    if not hugepage_settings:
        defaults = defaults.rstrip() + "\nHUGEPAGES=4096\n"
    (output / ".env").write_text(defaults)
    services = {role: {"image": image["id"], "pull_policy": "never", "environment": {"LAUNCH_DARKLY_API_KEY": ""}}
                for role, image in images.items() if role not in ("tools", "node-e2b")}
    services["orchestrator"] = {"environment": {"LAUNCH_DARKLY_API_KEY": ""}}
    write_json(output / "runtime.override.json", {"name": project, "services": services})
    artifact_mount = {"type": "bind", "source": compose_path(artifacts), "target": "/stock", "read_only": True}
    staging_environment = {"STOCK_ORCHESTRATOR_SHA256": digest, "STOCK_RUNTIME_OWNER": project + ":" + commit + ":" + digest,
                           **{name: "${" + name + ":?stock runtime requires its pinned artifact versions}" for name in
                              ["E2B_ENVD_VERSION", "E2B_FIRECRACKER_VERSION", "E2B_KERNEL_VERSION", "E2B_BUSYBOX_VERSION"]}}
    write_json(output / "compose.override.yaml", {"services": {"fetch-artifacts": {
        "pid": "host", "cgroup": "host",
        "volumes": [artifact_mount],
        "environment": staging_environment,
        "command": ["/bin/bash", "/stock/install-orchestrator.sh"],
    }, "host-setup": {
        "pid": "host", "cgroup": "host",
        "volumes": [{"type": "bind", "source": "/", "target": "/host"}, artifact_mount],
        "environment": staging_environment,
        "command": ["/bin/bash", "/stock/install-orchestrator.sh", "setup"],
    }, "preflight": {
        "cgroup": "host",
        "volumes": [{"type": "bind", "source": "/", "target": "/host", "read_only": True}, artifact_mount],
        "environment": staging_environment,
        "command": ["/bin/bash", "/stock/install-orchestrator.sh", "preflight"],
    }, "host-teardown": {
        "entrypoint": ["/bin/sh", "-c", "echo 'stock-runtime: host teardown is unsupported for this deployment' >&2; exit 1"],
        "command": [],
    }}})
    write_json(output / "collector.example.json", {
        "schemaVersion": 1, "project": project, "storagePath": "/var/lib/e2b/storage/templates",
        "buildCachePath": "/var/lib/e2b/storage/build-cache",
        "journalPath": "/var/lib/e2b/snapshot-collection.jsonl",
        "orchestratorAddress": "127.0.0.1:5008", "minimumAgeSeconds": 3600,
    })
    shutil.copyfile(Path(__file__).with_name("configure-stock-project.py"), output / "configure-project.py")
    write_json(output / "stock-runtime.lock.json", lock)
    write_json(output / "build.json", {
        "schemaVersion": 1, "sourceCommit": commit, "sourceArchiveSha256": sha256(archive),
        "orchestratorBuildVersion": version,
        "platform": "linux/" + arch, "composeProject": project, "expectedMigration": migration,
        "images": images, "orchestratorSha256": digest,
        "launcherSha256": sha256(embed / "scripts/orchestrator-launch.sh"),
        "installerSha256": sha256(artifacts / "install-orchestrator.sh"),
        "configurationSha256": {name: sha256(output / name) for name in
                                ["compose.yaml", ".env", "runtime.override.json", "compose.override.yaml", "collector.example.json", "configure-project.py"]},
    })
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New directory on a fresh, dedicated Linux host")
    parser.add_argument("--arch", choices=["arm64", "amd64"],
                        default={"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64"}.get(platform.machine()))
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error("Python 3.12 or newer is required for safe source archive extraction")
    if platform.system() != "Linux":
        parser.error("Run inside the dedicated Linux host; on macOS this is inside Lima")
    result = build(args.output, args.arch)
    print(f"Prepared stock runtime: {result / 'build.json'}")
    print("No services were started and no existing deployment was changed.")


if __name__ == "__main__":
    main()
