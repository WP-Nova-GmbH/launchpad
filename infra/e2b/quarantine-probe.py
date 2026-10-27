#!/usr/bin/env python3
"""Cold-boot a quiesced prepared disk without executing its programs or exposing network access.

This verifier does not commit placement, delete source data, or authorize ordinary
runner startup. Its caller must hold the disk pin. A protected host budget reserves probe capacity.
"""
import argparse
import contextlib
import fcntl
import signal
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sys
import subprocess
import time
import tempfile
import uuid


CGROUP_ROOT = Path("/sys/fs/cgroup/launchpad-quarantine-probes")
CAPACITY_LOCK = Path("/run/launchpad-quarantine-probes.lock")
SOCKET_ROOT = Path("/run/launchpad-quarantine-probes")
NORMAL_CGROUP_ROOT = Path("/sys/fs/cgroup/e2b")
HOST_BUDGET = Path("/etc/launchpad-e2b-host-capacity.json")
MEMINFO = Path("/proc/meminfo")
MIB = 1024 ** 2
PROBE_MEMORY_MIB = 5120
PROFILE_CPUS = 2


def memory_info():
    result = {}
    for line in MEMINFO.read_text().splitlines():
        fields = line.split()
        if fields[0] in {"MemTotal:", "MemAvailable:"}:
            if len(fields) != 3 or fields[2] != "kB":
                raise ValueError("Unknown physical memory accounting")
            result[fields[0][:-1]] = int(fields[1]) * 1024
    if set(result) != {"MemTotal", "MemAvailable"}:
        raise ValueError("Missing physical memory accounting")
    return result


def capacity_budget(max_running_vms, reserve_memory_mib, reserve_cpu_count):
    # Five GiB includes the four-GiB guest and its host process. The same
    # conservative profile is used for ordinary allocations and one cold probe.
    if (any(type(value) is not int for value in (max_running_vms, reserve_memory_mib, reserve_cpu_count))
            or max_running_vms < 1 or reserve_memory_mib < 2048 or reserve_cpu_count < 1):
        raise ValueError("Invalid host capacity budget")
    normal_memory = max_running_vms * PROBE_MEMORY_MIB * MIB
    normal_cpu = max_running_vms * PROFILE_CPUS
    physical = memory_info()
    cpus = len(os.sched_getaffinity(0))
    if (normal_memory + (PROBE_MEMORY_MIB + reserve_memory_mib) * MIB > physical["MemTotal"]
            or normal_cpu + PROFILE_CPUS + reserve_cpu_count > cpus):
        raise ValueError("Host cannot reserve the configured VMs, cold probe and system headroom")
    return {"format": "launchpad-host-capacity-v1", "maxRunningVms": max_running_vms,
            "reserveMemoryMiB": reserve_memory_mib, "reserveCpuCount": reserve_cpu_count,
            "normalMemoryMaxBytes": normal_memory, "normalCpuCount": normal_cpu,
            "probeMemoryMaxBytes": PROBE_MEMORY_MIB * MIB, "probeCpuCount": PROFILE_CPUS}


def configure_capacity(arguments):
    parser = argparse.ArgumentParser(description="Reserve one cold-probe profile outside ordinary VM capacity")
    parser.add_argument("--max-running-vms", type=int, required=True)
    parser.add_argument("--reserve-memory-mib", type=int, default=3072)
    parser.add_argument("--reserve-cpu-count", type=int, default=1)
    args = parser.parse_args(arguments)
    budget = capacity_budget(args.max_running_vms, args.reserve_memory_mib, args.reserve_cpu_count)
    with CAPACITY_LOCK.open("a+") as capacity_lock:
        fcntl.flock(capacity_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for root in (NORMAL_CGROUP_ROOT, CGROUP_ROOT):
            if root.is_symlink():
                raise ValueError("Unowned host capacity cgroup")
            if root.exists() and ("populated 0" not in (root / "cgroup.events").read_text() or any(child.is_dir() for child in root.iterdir())):
                raise RuntimeError("Stop ordinary and quarantine VMs before changing the host budget")
        if memory_info()["MemAvailable"] < budget["normalMemoryMaxBytes"]:
            raise RuntimeError("Insufficient host memory headroom to configure VM capacity")
        for root, memory, cpus in ((NORMAL_CGROUP_ROOT, budget["normalMemoryMaxBytes"], budget["normalCpuCount"]),
                                   (CGROUP_ROOT, budget["probeMemoryMaxBytes"], budget["probeCpuCount"])):
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            (root / "memory.max").write_text(str(memory))
            (root / "memory.swap.max").write_text("0")
            (root / "cpu.max").write_text(f"{cpus * 100000} 100000")
            (root / "cgroup.subtree_control").write_text("+cpu +memory")
        # A crash while changing limits leaves a mismatch, never a valid budget.
        HOST_BUDGET.parent.mkdir(parents=True, exist_ok=True)
        write_private(HOST_BUDGET, budget)
    print(f"Host capacity configured: {budget['maxRunningVms']} ordinary VM(s) plus one cold probe.")


def cpu_limit_matches(value, cpus):
    # E2B reinitializes the scheduling period on startup; compare the enforced
    # CPU quota rather than one spelling of the same limit.
    fields = value.split()
    if len(fields) != 2:
        return False
    try:
        quota, period = map(int, fields)
    except ValueError:
        return False
    return 1000 <= period <= 1000000 and quota == cpus * period


def load_capacity_budget():
    info = HOST_BUDGET.lstat()
    if (HOST_BUDGET.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077
            or not HOST_BUDGET.is_file() or info.st_size > 4096):
        raise ValueError("Unowned host capacity budget")
    budget = json.loads(HOST_BUDGET.read_text())
    if budget != capacity_budget(budget["maxRunningVms"], budget["reserveMemoryMiB"], budget["reserveCpuCount"]):
        raise ValueError("Host capacity budget differs from its supported profile")
    return budget


def restore_capacity():
    # Cgroup limits live in kernel memory. Restore the retained operator profile
    # before Docker starts after boot; never overwrite an occupied reservation.
    budget = load_capacity_budget()
    configure_capacity(["--max-running-vms", str(budget["maxRunningVms"]),
                        "--reserve-memory-mib", str(budget["reserveMemoryMiB"]),
                        "--reserve-cpu-count", str(budget["reserveCpuCount"])])


def require_capacity():
    budget = load_capacity_budget()
    for root, memory, cpus in ((NORMAL_CGROUP_ROOT, budget["normalMemoryMaxBytes"], budget["normalCpuCount"]),
                               (CGROUP_ROOT, budget["probeMemoryMaxBytes"], budget["probeCpuCount"])):
        if (root.is_symlink() or root.stat().st_uid != os.getuid()
                or (root / "memory.max").read_text().strip() != str(memory)
                or (root / "memory.swap.max").read_text().strip() != "0"
                or not cpu_limit_matches((root / "cpu.max").read_text(), cpus)):
            raise ValueError("Host capacity cgroup limits differ from the protected budget")
    # The lock blocks new ordinary admissions, but existing VMs can grow after
    # this inspection. Reserve their entire remaining parent-cgroup allowance,
    # including an empty pre-clone reservation whose writer has not started yet.
    remaining_normal = 0
    if any(child.is_dir() for child in NORMAL_CGROUP_ROOT.iterdir()):
        current = int((NORMAL_CGROUP_ROOT / "memory.current").read_text().strip())
        if not 0 <= current <= budget["normalMemoryMaxBytes"]:
            raise ValueError("Unknown ordinary VM memory usage")
        remaining_normal = budget["normalMemoryMaxBytes"] - current
    if memory_info()["MemAvailable"] < (PROBE_MEMORY_MIB + budget["reserveMemoryMiB"]) * MIB + remaining_normal:
        raise RuntimeError("Waiting for temporary VM verification capacity")
    return budget


def checksum(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_private(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".receipt-")
    try:
        with os.fdopen(fd, "w") as target:
            target.write(json.dumps(value) + "\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def publish_operation_directory(output, state):
    """Publish the protected intent before creating any execution resources."""
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=output.parent, prefix=".probe-journal-"))
    try:
        write_private(staging / "operation.json", state)
        if output.exists() or output.is_symlink():
            raise FileExistsError("Probe output already exists")
        os.rename(staging, output)
        directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        # Only the unpublished directory created by this call can be removed.
        if staging.exists():
            shutil.rmtree(staging)


def create_probe_socket(state):
    """Unix sockets have a short kernel limit, independent of the storage path."""
    expected = SOCKET_ROOT / str(uuid.UUID(state["operationId"]))
    if state.get("socketDirectory") != str(expected):
        raise ValueError("Unowned probe socket directory")
    SOCKET_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = SOCKET_ROOT.lstat()
    if SOCKET_ROOT.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unowned probe socket root")
    expected.mkdir(mode=0o700)
    return expected / "fc.sock"


def cleanup_probe_socket(state):
    # Earlier receipts did not allocate a separate socket directory.
    if "socketDirectory" not in state:
        return
    expected = SOCKET_ROOT / str(uuid.UUID(state["operationId"]))
    if state["socketDirectory"] != str(expected):
        raise ValueError("Unowned probe socket directory")
    if expected.exists():
        info = expected.lstat()
        if expected.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Unowned probe socket directory")
        (expected / "fc.sock").unlink(missing_ok=True)
        expected.rmdir()


def reconcile(output):
    """Reconcile only a protected, recorded direct-probe cgroup; never certify its disk."""
    output = Path(output).resolve(strict=True)
    private = output.stat()
    if private.st_uid != os.getuid() or private.st_mode & 0o077:
        raise ValueError("Unowned probe receipt directory")
    operation_path = output / "operation.json"
    if operation_path.stat().st_size > 65536:
        raise ValueError("Oversized probe operation")
    state = json.loads(operation_path.read_text())
    operation = str(uuid.UUID(state["operationId"]))
    expected = CGROUP_ROOT / operation
    if (state.get("format") != "launchpad-disk-probe-operation-v1" or
            state.get("executionMode") != "direct" or state.get("cgroupPath") != str(expected)):
        raise ValueError("Unowned probe cgroup")
    with CAPACITY_LOCK.open("a+") as capacity_lock:
        # A live controller keeps this lock. Its disappearance is not a stop receipt.
        fcntl.flock(capacity_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if expected.exists():
            (expected / "cgroup.kill").write_text("1")
            deadline = time.monotonic() + 30
            while "populated 1" in (expected / "cgroup.events").read_text():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Quarantine VM physical stop unconfirmed")
                time.sleep(0.05)
            expected.rmdir()
        cleanup_probe_socket(state)
        state["physicalStopConfirmed"] = True
        state["reconciled"] = True
        write_private(operation_path, state)
    print("Recorded quarantine process physically reconciled; no recovery certificate created.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disk", type=Path, required=True, help="Quiesced full prepared ext4 image")
    parser.add_argument("--disk-sha256", required=True, help="Verified published disk checksum")
    parser.add_argument("--required-files", type=Path, required=True, help="JSON array of path, size and sha256 entries from the verified catalog")
    parser.add_argument("--probe-build", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New private proof directory")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--direct", action="store_true", help="Use a private cgroup and network namespace without a Docker socket")
    parser.add_argument("--mount-only", action="store_true", help="Verify cold filesystem availability; does not certify native conversation files")
    args = parser.parse_args()
    if not 30 <= args.timeout <= 300 or re.fullmatch(r"[0-9a-f]{64}", args.disk_sha256) is None:
        parser.error("Invalid probe budget or disk checksum")
    if not args.direct:
        parser.error("Cold verification requires --direct host capacity admission")
    lock_path = Path(__file__).with_name("runtime.lock.json")
    lock = json.loads(lock_path.read_text())
    build = args.probe_build.resolve(strict=True)
    receipt = json.loads((build / "build.json").read_text())
    image = lock["baseImages"]["golang:${GOLANG_VERSION}-${DEBIAN_VERSION}"]
    if receipt.get("format") != "launchpad-disk-probe-build-v1" or receipt.get("platform") != "linux/arm64" or receipt.get("image") != image:
        raise ValueError("Unverified probe build")
    for filename, expected in [(build / "init", receipt["initSha256"]),
                               (build / "init_linux.go", receipt["sourceSha256"]),
                               (Path(__file__).with_name("quarantine") / "init_linux.go", receipt["sourceSha256"]),
                               (lock_path, receipt["runtimeLockSha256"])]:
        if checksum(filename) != expected:
            raise ValueError("Trusted probe build differs from the verified source")
    kernel = Path("/fc-kernels") / lock["artifacts"]["kernel"]["version"] / "arm64/vmlinux.bin"
    firecracker = Path("/fc-versions") / lock["artifacts"]["firecracker"]["version"] / "arm64/firecracker"
    for filename, key in [(kernel, "kernel"), (firecracker, "firecracker")]:
        if checksum(filename) != lock["artifacts"][key]["sha256"]:
            raise ValueError("Pinned boot asset differs from the verified runtime")
    disk = args.disk.resolve(strict=True)
    metadata_path = disk.parent / "metadata.json"
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else json.loads((disk.parent / "prepared.json").read_text())["metadata"]
    if metadata.get("filesystem_only") is not True or metadata.get("fs_quiesced") is not True:
        raise ValueError("Probe requires a quiesced prepared filesystem-only disk")
    if not disk.is_file() or checksum(disk) != args.disk_sha256:
        raise ValueError("Published recovery disk checksum mismatch")
    before = disk.stat()
    if args.required_files.stat().st_size > 1_048_576:
        raise ValueError("Required-file manifest is too large")
    required_bytes = args.required_files.read_bytes()
    required_sha256 = hashlib.sha256(required_bytes).hexdigest()
    required = json.loads(required_bytes)
    if not isinstance(required, list) or not (0 if args.mount_only else 1) <= len(required) <= 256:
        raise ValueError("Invalid required-file manifest")
    with contextlib.ExitStack() as stack:
        output = args.output.resolve()
        operation = str(uuid.uuid4())
        name = "launchpad-disk-probe-" + operation
        state = {"format": "launchpad-disk-probe-operation-v1", "operationId": operation,
                 "containerName": name, "diskSha256": args.disk_sha256,
                 "socketDirectory": str(SOCKET_ROOT / operation),
                 "physicalStopConfirmed": False, "temporaryCpuCount": 2, "temporaryMemoryMB": 5120, "guestMemoryMB": 4096}
        capacity_lock = stack.enter_context(CAPACITY_LOCK.open("a+"))
        # One host reservation covers every prepared-build directory. A lock
        # beside each output would allow unrelated builds to probe concurrently.
        fcntl.flock(capacity_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state["executionMode"] = "direct"
        state["cgroupPath"] = str(CGROUP_ROOT / operation)
        state["hostCapacityBudget"] = require_capacity()
        publish_operation_directory(output, state)
        initrd = output / "initrd"
        initrd.mkdir(mode=0o700)
        shutil.copyfile(build / "init", initrd / "init")
        (initrd / "init").chmod(0o700)
        nonce = secrets.token_hex(16)
        write_private(initrd / "proof.json", {"nonce": nonce, "files": required, "mountOnly": args.mount_only})
        with (output / "initrd.cpio").open("wb") as target:
            subprocess.run(["cpio", "--create", "--format=newc", "--quiet"], cwd=initrd,
                           input=b"init\nproof.json\n", stdout=target, check=True)
        socket_path = SOCKET_ROOT / operation / "fc.sock"

        class UnixHTTP(http.client.HTTPConnection):
            def connect(self):
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(self.timeout)
                self.sock.connect(str(socket_path))

        def api(path, body):
            client = UnixHTTP("localhost", timeout=30)
            try:
                client.request("PUT", path, json.dumps(body), {"Content-Type": "application/json"})
                response = client.getresponse()
                response.read()
                if response.status != 204:
                    raise RuntimeError(f"Quarantine boot configuration failed: {path} ({response.status})")
            finally:
                client.close()

        direct = None
        group = None
        boot_log = None
        def terminate(_signal, _frame):
            raise InterruptedError("Quarantine controller interrupted")
        signal.signal(signal.SIGTERM, terminate)
        capacity = CGROUP_ROOT
        capacity.mkdir(mode=0o700, exist_ok=True)
        # An orphan is still using the reservation. Never interpret a missing
        # controller as permission to allocate another verification VM.
        if "populated 1" in (capacity / "cgroup.events").read_text():
            raise RuntimeError("Quarantine capacity requires physical reconciliation")
        (capacity / "memory.max").write_text(str(5 * 1024**3))
        (capacity / "memory.swap.max").write_text("0")
        (capacity / "cpu.max").write_text("200000 100000")
        (capacity / "cgroup.subtree_control").write_text("+cpu +memory")
        group = capacity / operation
        group.mkdir(mode=0o700)
        result = None
        started = time.monotonic()
        try:
            socket_path = create_probe_socket(state)
            def join_group():
                (group / "cgroup.procs").write_text(str(os.getpid()))
            boot_log = (output / "boot.log").open("wb")
            direct = subprocess.Popen(["unshare", "--net", "--", str(firecracker), "--api-sock", str(socket_path)],
                                      stdin=subprocess.DEVNULL, stdout=boot_log, stderr=subprocess.STDOUT,
                                      preexec_fn=join_group)
            state["processId"] = direct.pid
            write_private(output / "operation.json", state)
            deadline = time.monotonic() + 15
            while not socket_path.exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Quarantine Firecracker API did not start")
                time.sleep(0.02)
            # The pinned kernel embeds bpfilter_umh, a userspace helper unnecessary in
            # a NIC-less probe. Exclude its initcall so the only userspace code is our PID 1.
            api("/boot-source", {"kernel_image_path": str(kernel), "initrd_path": str(output / "initrd.cpio"),
                                 "boot_args": "console=ttyS0 quiet loglevel=1 rdinit=/init panic=1 reboot=k pci=off random.trust_cpu=on initcall_blacklist=load_umh"})
            api("/machine-config", {"vcpu_count": 2, "mem_size_mib": 4096, "smt": False, "track_dirty_pages": False})
            api("/drives/recovered", {"drive_id": "recovered", "path_on_host": str(disk), "is_root_device": False, "is_read_only": True})
            state["phase"] = "booting"
            write_private(output / "operation.json", state)
            api("/actions", {"action_type": "InstanceStart"})
            state["phase"] = "running"
            write_private(output / "operation.json", state)
            if direct is not None:
                direct.wait(timeout=args.timeout)
                boot_log.close()
                boot_log = None
                logs = (output / "boot.log").read_bytes()[-65536:]
            matches = re.findall(rb"\[launchpad-disk-probe-v1\](\{[^\r\n]*\})", logs)
            if len(matches) != 1:
                raise RuntimeError("Trusted recovery receipt missing or ambiguous")
            result = json.loads(matches[0])
            if (result.get("format") != "launchpad-disk-probe-v1" or result.get("nonce") != nonce
                    or result.get("phase") != "quarantine" or result.get("verified") is not True
                    or result.get("userProcesses") != [1] or result.get("files") != len(required)
                    or result.get("mountOnly") is not args.mount_only):
                raise RuntimeError("Quarantined recovery verification failed")
            after = disk.stat()
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise RuntimeError("Saved disk changed during verification")
        finally:
            if group is not None:
                # This exact private cgroup was created and recorded before spawn.
                # Kill its descendants too; a wait on the launcher alone is insufficient.
                (group / "cgroup.kill").write_text("1")
                if direct is not None:
                    direct.wait(timeout=30)
                if "populated 1" in (group / "cgroup.events").read_text():
                    raise RuntimeError("Quarantine VM physical stop unconfirmed")
                group.rmdir()
                state["physicalStopConfirmed"] = True
                write_private(output / "operation.json", state)
            if boot_log is not None:
                boot_log.close()
            cleanup_probe_socket(state)
        if not state["physicalStopConfirmed"]:
            raise RuntimeError("Quarantine VM physical stop unconfirmed")
        if checksum(args.required_files) != required_sha256:
            raise RuntimeError("Required-file catalog changed during verification")
        write_private(output / "verified.json", {"format": "launchpad-disk-probe-result-v1", "operationId": operation,
                      "diskSha256": args.disk_sha256, "initSha256": receipt["initSha256"],
                      "requiredFilesSha256": required_sha256, "physicalStopConfirmed": True,
                      "mountOnly": args.mount_only,
                      "durationSeconds": time.monotonic() - started, "receipt": result})
        print("Quarantined recovery verified; probe physically stopped; saved disk preserved.")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "configure-capacity":
        configure_capacity(sys.argv[2:])
    elif len(sys.argv) == 2 and sys.argv[1] == "restore-capacity":
        restore_capacity()
    elif len(sys.argv) == 2 and sys.argv[1] == "check-capacity":
        with CAPACITY_LOCK.open("a+") as capacity_lock:
            fcntl.flock(capacity_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require_capacity()
        print("Host cold-probe capacity and physical headroom verified.")
    elif len(sys.argv) == 3 and sys.argv[1] == "reconcile":
        reconcile(sys.argv[2])
    else:
        main()
