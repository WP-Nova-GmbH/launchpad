#!/usr/bin/python3 -I
"""Guest workload tracking, not a security boundary against guest root.

The VM remains the isolation boundary. Delegated cgroups retain ordinary detached
children after their parent exits. The server stays outside these groups so it can
export a stopped workspace. Every launch and seal shares one kernel lock.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path("/sys/fs/cgroup/user/launchpad-workloads")
STATE = Path("/run/launchpad-workloads")
BOOT = Path("/proc/sys/kernel/random/boot_id")
IDENTIFIER = re.compile(r"[a-f0-9]{32}\Z")
KINDS = {"process", "provider", "terminal"}


def identifier(value):
    if not IDENTIFIER.fullmatch(value):
        raise ValueError("Invalid workload identifier")
    return value


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    # Callers hold the lock; replace prevents an interrupted write from being
    # mistaken for an empty/open gate. /run is specific to this kernel boot.
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def initialize():
    if os.getuid() != 0 or not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise RuntimeError("Workload tracking requires guest root and cgroup v2")
    import pwd
    owner = pwd.getpwnam("user")
    parent = ROOT.parent
    parent.mkdir(exist_ok=True)
    ROOT.mkdir(exist_ok=True)
    STATE.mkdir(mode=0o700, exist_ok=True)
    # cgroup v2 requires write access at the common ancestor when moving the
    # launcher from envd's /user group into its newly created child group.
    for path in [ROOT, ROOT / "cgroup.procs", parent / "cgroup.procs", STATE]:
        os.chown(path, owner.pw_uid, owner.pw_gid)
    lock = STATE / "lock"
    lock.touch(exist_ok=True)
    os.chown(lock, owner.pw_uid, owner.pw_gid)
    with lock.open("r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        gate = STATE / "gate.json"
        boot_id = BOOT.read_text().strip()
        if gate.exists():
            if read_json(gate)["bootId"] != boot_id:
                raise RuntimeError("Unexpected workload state from another boot")
            return
        # No user processes autostart in the template. The server's durable
        # ownership fence still controls setup and every execution admission.
        write_json(gate, {"bootId": boot_id, "sealedBy": None, "epoch": 0})
        os.chown(gate, owner.pw_uid, owner.pw_gid)


@contextlib.contextmanager
def locked():
    with (STATE / "lock").open("r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        gate = read_json(STATE / "gate.json")
        if gate["bootId"] != BOOT.read_text().strip():
            raise RuntimeError("Workload boot identity changed")
        yield gate


def populated(group):
    values = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
    if values.get("populated") not in {"0", "1"}:
        raise RuntimeError("Workload occupancy is unknown")
    return values["populated"] == "1"


def inventory(gate):
    groups = []
    for group in sorted(ROOT.iterdir()):
        if not group.is_dir():
            continue
        identifier(group.name)
        record_path = STATE / (group.name + ".json")
        if populated(group):
            record = read_json(record_path)
            if record["bootId"] != gate["bootId"] or record["id"] != group.name:
                raise RuntimeError("Unrecognized workload group")
            groups.append(record)
        else:
            # An interrupted launcher may have created its empty group before
            # writing metadata. Under this lock no managed launch can enter it.
            group.rmdir()
            record_path.unlink(missing_ok=True)
    return {**gate, "groups": groups, "stopped": not groups}


def process_identity(pid):
    raw = Path(f'/proc/{pid}/stat').read_text()
    fields = raw[raw.rindex(') ') + 2:].split()
    return {'startTicks': fields[19], 'processGroup': int(fields[2])}


def native_identity(gate, work_id, pid):
    import hashlib
    manifest = Path('/opt/launchpad/codex-native.json')
    info = manifest.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or manifest.is_symlink():
        raise RuntimeError('Native manifest is not immutable')
    native = read_json(manifest)
    executable = Path(native['executable'])
    info = executable.stat()
    if (native['version'] != '0.159.3' or info.st_uid != 0 or info.st_mode & 0o022
            or not info.st_mode & 0o111 or executable.resolve() != Path(f'/proc/{pid}/exe').resolve()
            or hashlib.sha256(executable.read_bytes()).hexdigest() != native['sha256']):
        raise RuntimeError('Native executable identity changed')
    record = read_json(STATE / (work_id + '.json'))
    stat = process_identity(pid)
    if (record['id'] != work_id or record['kind'] != 'provider' or record['leaderPid'] != pid
            or record['bootId'] != gate['bootId'] or record['startTicks'] != stat['startTicks']
            or stat['processGroup'] != pid):
        raise RuntimeError('Native leader identity changed')
    return {'bootId': gate['bootId'], 'groupId': work_id, 'pid': pid,
            'startTicks': stat['startTicks'], 'executableSha256': native['sha256']}


def wait_cgroup_event(group, key, value, seconds=2):
    import select
    with (group / 'cgroup.events').open() as events:
        poll = select.poll()
        poll.register(events, select.POLLPRI | select.POLLERR)
        deadline = time.monotonic() + seconds
        while True:
            events.seek(0)
            if dict(line.split() for line in events.read().splitlines()).get(key) == value:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Kernel workload receipt is unavailable')
            poll.poll(max(1, int(remaining * 1000)))


def exclusive_provider(group, identity):
    # A subtree, including an empty unexpected one, is not a single owned harness.
    if any(p.is_dir() for p in group.iterdir()):
        return False
    if set(map(int, (group / 'cgroup.procs').read_text().split())) != {identity['pid']}:
        return False
    members = set()
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if process_identity(int(entry.name))['processGroup'] == identity['pid']:
                members.add(int(entry.name))
        except FileNotFoundError:
            continue
    return members == {identity['pid']}


def stop_idle_provider(gate, expected, operation):
    import signal
    work_id = identifier(expected['groupId'])
    if gate['bootId'] != expected['bootId'] or gate['sealedBy'] not in {None, operation}:
        return {'admitted': False}
    attempted = STATE / ('provider-stop-' + work_id + '.json')
    if attempted.exists():
        recorded = read_json(attempted)
        if recorded != {'identity': expected, 'operation': operation, 'signalReserved': True}:
            raise RuntimeError('Another operation owns this stop')
        # This records only a reserved attempt, including an uncertain syscall.
        # The runtime must still observe its own child exit and flushed output;
        # a retry is never permission to signal again or claim physical exit.
        return {'admitted': True}
    current = inventory(gate)
    if len(current['groups']) != 1 or current['groups'][0]['id'] != work_id:
        return {'admitted': False}
    if native_identity(gate, work_id, expected['pid']) != expected:
        return {'admitted': False}
    group = ROOT / work_id
    pidfd = os.pidfd_open(expected['pid'])
    frozen = False
    try:
        (group / 'cgroup.freeze').write_text('1')
        frozen = True
        wait_cgroup_event(group, 'frozen', '1')
        if (native_identity(gate, work_id, expected['pid']) != expected
                or not exclusive_provider(group, expected)):
            return {'admitted': False}
        # Admission and any managed launch share this lock. No other group was
        # live, and the freezer prevents a child racing the ownership check.
        if gate['sealedBy'] is None:
            gate['epoch'] += 1
            gate['sealedBy'] = operation
            write_json(STATE / 'gate.json', gate)
        # Reserve before the syscall. If its result is uncertain, preserve the
        # attempt and gate; a retry never becomes permission to signal again.
        write_json(attempted, {'identity': expected, 'operation': operation, 'signalReserved': True})
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        return {'admitted': True}
    finally:
        try:
            if frozen:
                (group / 'cgroup.freeze').write_text('0')
        finally:
            os.close(pidfd)


def main(args):
    action = args[0]
    if action == "initialize" and len(args) == 1:
        initialize()
        return
    if action in {"run", "run-transfer"}:
        transfer = action == "run-transfer"
        if transfer:
            _, boot_id, operation_id, epoch, work_id, separator, *command = args
            identifier(operation_id)
            kind = "transfer"
        else:
            _, work_id, kind, separator, *command = args
        identifier(work_id)
        if (not transfer and kind not in KINDS) or separator != "--" or not command:
            raise ValueError("Invalid workload command")
        with locked() as gate:
            if transfer:
                if (gate["bootId"] != boot_id or gate["sealedBy"] != operation_id
                        or gate["epoch"] != int(epoch)):
                    raise RuntimeError("Transfer does not own the workload seal")
            elif gate["sealedBy"] is not None:
                raise RuntimeError("Workload launches are sealed")
            if time.monotonic() - gate.get("lastSweep", 0) >= 30:
                inventory(gate)
                gate["lastSweep"] = time.monotonic()
                write_json(STATE / "gate.json", gate)
            group = ROOT / work_id
            group.mkdir()  # An existing ID is never a retry invitation.
            write_json(STATE / (work_id + ".json"), {
                "id": work_id, "kind": kind, "leaderPid": os.getpid(),
                "bootId": gate["bootId"],
                "startTicks": process_identity(os.getpid())["startTicks"],
            })
            (group / "cgroup.procs").write_text(str(os.getpid()))
        # No shell interpolation; cwd, environment, pipes and PTY survive exec.
        os.execvpe(command[0], command, os.environ)
    with locked() as gate:
        if action == 'provider-identity' and len(args) == 3:
            _, work_id, pid = args
            print(json.dumps(native_identity(gate, identifier(work_id), int(pid))))
            return
        if action == 'stop-idle-provider' and len(args) == 4:
            _, operation, work_id, raw = args
            expected = json.loads(raw)
            if expected['groupId'] != identifier(work_id):
                raise ValueError('Unexpected owned group')
            print(json.dumps(stop_idle_provider(gate, expected, identifier(operation))))
            return
        if action in {"seal", "reopen", "stop"} and len(args) == 3:
            _, boot_id, operation_id = args
            identifier(operation_id)
            if boot_id != gate["bootId"]:
                raise RuntimeError("Stale workload boot")
            if action in {"seal", "stop"}:
                if gate["sealedBy"] not in {None, operation_id}:
                    raise RuntimeError("Another operation sealed these workloads")
                if gate["sealedBy"] is None:
                    gate["epoch"] += 1
                gate["sealedBy"] = operation_id
            else:
                if gate["sealedBy"] != operation_id:
                    raise RuntimeError("Only the owning operation may reopen workloads")
                gate["epoch"] += 1
                gate["sealedBy"] = None
            write_json(STATE / "gate.json", gate)
            if action == "stop":
                # Only recognized groups from this boot are targets. The gate
                # prevents a concurrent launch while the kernel kills children.
                current = inventory(gate)
                for record in current["groups"]:
                    (ROOT / record["id"] / "cgroup.kill").write_text("1")
        elif action != "inspect" or len(args) != 1:
            raise ValueError("Invalid workload action")
        print(json.dumps(inventory(gate)))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        # Arguments/environment can contain provider credentials; never echo them.
        print("Launchpad workload tracking failed; execution remains unconfirmed.", file=sys.stderr)
        sys.exit(74)
