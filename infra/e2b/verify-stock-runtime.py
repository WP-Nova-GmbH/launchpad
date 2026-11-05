#!/usr/bin/env python3
"""Verify one stock deployment and optionally start its native services."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import stat
import subprocess
import sys

SOURCE = "518278060a154124a80d98f37253f8af77baf478"
VERSION = "v0.16.202610271020-stock.518278060a15"
SOURCE_ARCHIVE_SHA256 = "aca63499162abe11133e83d7f61501e3199b27f0e34ed6dbfa69af90efde522e"
PROJECT_ID = "0b8a3ded-4489-4722-afd1-1d82e64ec2d5"
COMPOSE_FILES = ("compose.yaml", "runtime.override.json", "compose.override.yaml")
CONFIG_FILES = (*COMPOSE_FILES, ".env", "collector.example.json", "configure-project.py")
IMAGE_ROLES = ("api", "client-proxy", "db-migrator", "dashboard-api", "tools", "node-e2b")
TOOLS_SERVICES = ("orchestrator", "preflight", "host-setup", "fetch-artifacts", "api-secrets", "ready", "host-teardown")
COLLECTOR_JOURNAL = "/var/lib/e2b/snapshot-collection.jsonl"


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(*args, input=None):
    env = {name: os.environ[name] for name in ("PATH", "HOME", "USER", "LOGNAME", "TMPDIR") if name in os.environ}
    result = subprocess.run(args, input=input, capture_output=True, text=True, env=env)
    if result.returncode:
        raise ValueError("Stock runtime command failed; inspect the selected deployment locally")
    return result.stdout


def load(directory):
    directory = Path(directory).resolve(strict=True)
    receipt = json.loads((directory / "build.json").read_text())
    if (receipt.get("schemaVersion") != 1 or receipt.get("sourceCommit") != SOURCE
            or receipt.get("orchestratorBuildVersion") != VERSION
            or receipt.get("sourceArchiveSha256") != SOURCE_ARCHIVE_SHA256
            or not re.fullmatch(r"launchpad-e2b-stock-[a-f0-9]{16}", receipt.get("composeProject", ""))):
        raise ValueError("This is not a supported stock deployment. Preserve existing VM data and select a new stock directory with E2B_RUNTIME_DIR")
    architecture = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if not architecture or receipt.get("platform") != "linux/" + architecture:
        raise ValueError("The stock deployment was built for another host architecture")
    if set(receipt.get("images", {})) != set(IMAGE_ROLES):
        raise ValueError("Stock build receipt is incomplete; build all six native images")
    for image in receipt["images"].values():
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("id", "")):
            raise ValueError("Stock build has no immutable image identity")
    checksums = receipt.get("configurationSha256", {})
    for name in CONFIG_FILES:
        if sha(directory / name) != checksums.get(name):
            raise ValueError("Stock deployment configuration differs from its build receipt")
    for name, field in (("artifacts/orchestrator", "orchestratorSha256"),
                        ("artifacts/install-orchestrator.sh", "installerSha256")):
        if sha(directory / name) != receipt.get(field):
            raise ValueError("Stock runtime artifacts differ from their build receipt")
    lock = json.loads((directory / "stock-runtime.lock.json").read_text())
    if (lock.get("source", {}).get("commit") != SOURCE or lock.get("orchestratorBuildVersion") != VERSION
            or lock["source"].get("archiveSha256") != receipt.get("sourceArchiveSha256")):
        raise ValueError("Stock source provenance is incomplete")
    return directory, receipt


def compose(directory, receipt):
    return ["docker", "compose", "--project-directory", str(directory), "--project-name", receipt["composeProject"],
            *[value for name in COMPOSE_FILES for value in ("--file", str(directory / name))]]


def verify_configuration(receipt, configuration):
    if configuration.get("name") != receipt["composeProject"]:
        raise ValueError("Resolved Compose project differs from the selected stock deployment")
    services = configuration["services"]
    for role in ("api", "client-proxy", "db-migrator", "dashboard-api"):
        if services[role].get("image") != receipt["images"][role]["id"]:
            raise ValueError("Resolved native service image differs from its build receipt")
    for role in TOOLS_SERVICES:
        if services[role].get("image") != receipt["images"]["tools"]["id"]:
            raise ValueError("Resolved native tools image differs from its build receipt")
    for role in ("base-template", "smoke"):
        if services[role].get("image") != receipt["images"]["node-e2b"]["id"]:
            raise ValueError("Resolved native SDK image differs from its build receipt")
    orchestrator = services["orchestrator"]
    environment = orchestrator.get("environment", {})
    # Same native namespace/launcher profile required by the host collector.
    if (orchestrator.get("network_mode") != "host" or orchestrator.get("pid") != "host"
            or orchestrator.get("cgroup") != "host" or orchestrator.get("privileged") is not True
            or orchestrator.get("entrypoint") not in (None, [])
            or orchestrator.get("command") != ["/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"]
            or environment.get("OL_COMMAND", "").strip()
            or environment.get("OL_CGROUP_ROOT", "/sys/fs/cgroup/e2b") != "/sys/fs/cgroup/e2b"
            or environment.get("ORCHESTRATOR_SERVICES") != "orchestrator,template-manager"
            or environment.get("TEMPLATE_STORAGE_URL") != "file:///var/lib/e2b/storage/templates"
            or environment.get("BUILD_CACHE_STORAGE_URL") != "file:///var/lib/e2b/storage/build-cache"
            or any(service.get("environment", {}).get("LAUNCH_DARKLY_API_KEY", "").strip() for service in services.values())
            or "launchpad-keepalive" in services):
        raise ValueError("Resolved runtime does not use the supported unmodified native launcher and storage")


def root_file(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise ValueError("Installed runtime controls must be root-owned regular files")


@contextlib.contextmanager
def maintenance_lock(path=Path("/run/lock/launchpad-e2b-snapshot-collector.lock")):
    # Same canonical inode as native setup and the physical snapshot collector.
    # Never recreate/unlink it: that would create two independent host locks.
    if path.parent.resolve(strict=True) != path.parent:
        raise ValueError("The native maintenance lock directory must be canonical")
    root_file(path)
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened, current = os.fstat(descriptor), path.lstat()
        if (opened.st_uid != 0 or opened.st_nlink != 1 or opened.st_mode & 0o777 != 0o600
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError("The native maintenance lock changed while opening it")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Native E2B maintenance is active; retry startup after it finishes") from None
        yield
    finally:
        os.close(descriptor)


def verify_maintenance(directory, receipt, host_root=Path("/")):
    guidance = "Snapshot maintenance is unfinished or unconfirmed. Run the snapshot collector with its owning configuration and --apply to recover it before retrying startup"
    try:
        config = json.loads((directory / "collector.example.json").read_text())
        if config.get("journalPath") != COLLECTOR_JOURNAL or config.get("project") != receipt["composeProject"]:
            raise ValueError("Collector profile differs from the deployment")
        expected = {name: config[name] for name in ("project", "storagePath", "buildCachePath", "orchestratorAddress")}
        path = host_root / (COLLECTOR_JOURNAL + ".maintenance.json").lstrip("/")
        if path.parent.resolve(strict=True) != path.parent:
            raise ValueError("Maintenance directory must be canonical")
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        except FileNotFoundError:
            return
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
                raise ValueError("Maintenance receipt must be private and root-owned")
            data = stream.read((64 << 10) + 1)
            if len(data) > 64 << 10:
                raise ValueError("Maintenance receipt is too large")
            record = json.loads(data)
        if (set(record) != {"schemaVersion", "identity", "phase", "deployment", "attemptedStopIds"}
                or type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1
                or record["identity"] != expected or record["phase"] != "restored"):
            raise ValueError("Maintenance has not been restored")
        deployment = record["deployment"]
        if set(deployment) != {"Writers", "Orchestrator", "Database", "Roles"} or type(deployment["Writers"]) is not list or not deployment["Writers"]:
            raise ValueError("Maintenance deployment is incomplete")
        writers, roles = deployment["Writers"], deployment["Roles"]
        ids = [*writers, deployment["Orchestrator"], deployment["Database"]]
        if (any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in ids)
                or len(set(ids)) != len(ids) or not isinstance(roles, dict) or set(roles) != set(ids)
                or roles[deployment["Orchestrator"]] != "orchestrator" or roles[deployment["Database"]] != "postgres"):
            raise ValueError("Maintenance container identities are invalid")
        writer_roles = [roles[value] for value in writers]
        if any(value not in ("api", "dashboard-api", "client-proxy") for value in writer_roles) or len(set(writer_roles)) != len(writer_roles) or "api" not in writer_roles:
            raise ValueError("Maintenance writer identities are invalid")
        attempted = record["attemptedStopIds"]
        if (type(attempted) is not list or any(value not in [*writers, deployment["Orchestrator"]] for value in attempted)
                or len(set(attempted)) != len(attempted)
                or (deployment["Orchestrator"] in attempted and not set(writers).issubset(attempted))):
            raise ValueError("Maintenance stop identities are invalid")
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError(guidance) from None


def verify_host(receipt, policy_sha256, running, host_root=Path("/")):
    owner = host_root / "var/lib/e2b/launchpad-stock-runtime-owner"
    binary = host_root / "var/lib/e2b/bin/orchestrator"
    root_file(owner)
    root_file(binary)
    if (owner.read_text().strip() != f"{receipt['composeProject']}:{SOURCE}:{receipt['orchestratorSha256']}"
            or sha(binary) != receipt["orchestratorSha256"]):
        raise ValueError("Installed E2B belongs to another deployment; preserve it and complete stock host setup first")
    policy = host_root / "etc/launchpad/host-firewall.nft"
    checker = host_root / "usr/local/libexec/launchpad-host-firewall"
    root_file(policy)
    root_file(checker)
    if not re.fullmatch(r"[a-f0-9]{64}", policy_sha256) or sha(policy) != policy_sha256:
        raise ValueError("Install the current Launchpad host firewall policy before starting stock E2B")
    run(str(checker), "check")
    cgroups = host_root / "sys/fs/cgroup/e2b"
    if not running and cgroups.exists():
        for events in cgroups.rglob("cgroup.events"):
            if dict(line.split() for line in events.read_text().splitlines()).get("populated") != "0":
                raise ValueError("Native workloads remain without their orchestrator; recover the owning deployment before startup")


def verify_exclusive_host(receipt):
    ids = run("docker", "ps", "--no-trunc", "--quiet", "--filter", "label=com.docker.compose.service=orchestrator").split()
    if any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in ids):
        raise ValueError("Native host inventory is unconfirmed")
    if not ids:
        return False
    containers = json.loads(run("docker", "inspect", *ids))
    if len(containers) != len(ids) or {item["Id"] for item in containers} != set(ids):
        raise ValueError("Native host inventory changed")
    for item in containers:
        config = item["Config"]
        namespace = item.get("HostConfig", {})
        environment = dict(value.split("=", 1) for value in config.get("Env", []))
        labels = config.get("Labels") or {}
        if labels.get("com.docker.compose.project") != receipt["composeProject"]:
            raise ValueError("Another E2B deployment is running; no containers were stopped or modified")
        if (item["Image"] != receipt["images"]["tools"]["id"]
                or config.get("Cmd") != ["/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"]
                or config.get("Entrypoint") not in (None, [])
                or namespace.get("NetworkMode") != "host" or namespace.get("PidMode") != "host"
                or namespace.get("CgroupnsMode") != "host" or namespace.get("Privileged") is not True
                or environment.get("OL_COMMAND", "").strip()
                or environment.get("OL_CGROUP_ROOT", "/sys/fs/cgroup/e2b") != "/sys/fs/cgroup/e2b"
                or environment.get("ORCHESTRATOR_SERVICES") != "orchestrator,template-manager"):
            raise ValueError("The running deployment differs from this stock receipt; stop it explicitly before changing runtimes")
    return True


def verify_kernel(configuration, host_root=Path("/")):
    # Reboot can retain the receipt/binary while losing the kernel setup.
    # Inspect total reserved hugepages, not free pages occupied by live VMs.
    environment = configuration["services"]["host-setup"].get("environment", {})
    try:
        expected = {name: int(environment.get(name, default)) for name, default in (("HUGEPAGES", 4096), ("NBDS_MAX", 64))}
        if min(expected.values()) <= 0:
            raise ValueError("Invalid native host settings")
        for path, minimum in (("proc/sys/vm/nr_hugepages", expected["HUGEPAGES"]),
                              ("sys/module/nbd/parameters/nbds_max", expected["NBDS_MAX"]),
                              ("proc/sys/net/ipv4/tcp_max_syn_backlog", 65535),
                              ("proc/sys/vm/max_map_count", 1048576)):
            if int((host_root / path).read_text().strip()) < minimum:
                raise ValueError("Native kernel settings are incomplete")
        memory = dict(line.split(":", 1) for line in (host_root / "proc/meminfo").read_text().splitlines())
        if memory.get("Hugepagesize", "").strip() != "2048 kB":
            raise ValueError("Native E2B requires 2 MiB hugepages")
        for path, predicate in (("dev/nbd0", stat.S_ISBLK), ("dev/kvm", stat.S_ISCHR), ("dev/net/tun", stat.S_ISCHR)):
            if not predicate((host_root / path).stat().st_mode):
                raise ValueError("Native kernel devices are incomplete")
        if not (host_root / "var/run/netns").is_dir():
            raise ValueError("Native network namespace directory is missing")
        run("iptables", "-w", "5", "-t", "mangle", "-C", "FORWARD", "-p", "tcp", "--tcp-flags", "SYN,RST", "SYN", "-j", "TCPMSS", "--clamp-mss-to-pmtu")
    except (OSError, ValueError):
        raise ValueError("Native host setup is incomplete. Safely pause its VMs, explicitly stop this deployment's services, then retry start:vm-host to restore kernel setup") from None


def configure_limits(directory, receipt, command):
    ids = run(*command, "ps", "--quiet", "postgres").split()
    if len(ids) != 1 or not re.fullmatch(r"[a-f0-9]{64}", ids[0]):
        raise ValueError("Expected one PostgreSQL service in the selected stock deployment")
    inspected = json.loads(run("docker", "inspect", ids[0]))
    if (len(inspected) != 1 or inspected[0]["Id"] != ids[0] or not inspected[0]["State"]["Running"]
            or inspected[0]["Config"]["Labels"].get("com.docker.compose.project") != receipt["composeProject"]
            or inspected[0]["Config"]["Labels"].get("com.docker.compose.service") != "postgres"):
        raise ValueError("PostgreSQL ownership differs from the selected stock deployment")
    raw = run("docker", "exec", "--interactive", ids[0], "psql", "-X", "--quiet", "--tuples-only", "--no-align",
              "--no-password", "--set", "ON_ERROR_STOP=1", "--username", "postgres", "--dbname", "postgres",
              input=f"SELECT json_build_object('diskMb',disk_mb,'maxLengthHours',max_length_hours) FROM public.project_limits WHERE team_id='{PROJECT_ID}'::uuid;")
    limits = json.loads(raw) if raw.strip() else None
    if limits and limits.get("diskMb") == 32768 and type(limits.get("maxLengthHours")) is int and 1 <= limits["maxLengthHours"] <= 8760:
        return
    # The verified helper refuses a running API or any template in this exact
    # project, preserving existing deployments and the API's cached limits.
    run(sys.executable, str(directory / "configure-project.py"), "--runtime-dir", str(directory), "--project-id", PROJECT_ID)


def verify(directory, policy_sha256, start=False):
    directory, receipt = load(directory)
    command = compose(directory, receipt)
    configuration = json.loads(run(*command, "--profile", "*", "config", "--format", "json"))
    verify_configuration(receipt, configuration)
    verify_maintenance(directory, receipt)
    running = verify_exclusive_host(receipt)
    verify_host(receipt, policy_sha256, running)
    if running or not start:
        verify_kernel(configuration)
    elif start:
        # Native setup/fetch acquire the same host lock themselves. Run them
        # before taking the startup lock, then revalidate before any writers.
        print("[vm-host] Restoring native host prerequisites…", flush=True)
        for service in ("preflight", "host-setup", "fetch-artifacts"):
            run(*command, "run", "--rm", "--no-deps", service)
    with maintenance_lock() if start else contextlib.nullcontext():
        directory, receipt = load(directory)
        command = compose(directory, receipt)
        configuration = json.loads(run(*command, "--profile", "*", "config", "--format", "json"))
        verify_configuration(receipt, configuration)
        verify_maintenance(directory, receipt)
        running = verify_exclusive_host(receipt)
        verify_host(receipt, policy_sha256, running)
        verify_kernel(configuration)
        if start:
            print("[vm-host] Starting the selected native database and seed…", flush=True)
            run(*command, "up", "--no-build", "--no-deps", "-d", "--wait", "postgres", "redis", "clickhouse")
            # Partial `up --wait` treats a one-shot as running unless a selected
            # dependent requires its completion. Blocking run returns its exit
            # status before limits or consumers can observe unfinished state.
            for service in ("db-migrator", "seed"):
                run(*command, "run", "--rm", "--no-deps", service)
            configure_limits(directory, receipt, command)
            for service in ("clickhouse-migrator", "api-secrets"):
                run(*command, "run", "--rm", "--no-deps", service)
            print("[vm-host] Starting the native E2B API, proxy and orchestrator…", flush=True)
            # Setup/fetch above have their own lock; never recurse into them
            # through dependencies while holding the physical collector lock.
            run(*command, "up", "--no-build", "--no-deps", "-d", "--wait", "vector")
            run(*command, "up", "--no-build", "--no-deps", "-d", "--wait", "orchestrator")
            run(*command, "up", "--no-build", "--no-deps", "-d", "--wait", "api", "client-proxy", "dashboard-api")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--firewall-policy-sha256", required=True)
    parser.add_argument("--start", action="store_true")
    args = parser.parse_args()
    try:
        verify(args.runtime_dir, args.firewall_policy_sha256, args.start)
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"stock-runtime: {error}\n")
    print("Stock runtime verified" + (" and native services ready." if args.start else "."))


if __name__ == "__main__":
    main()
