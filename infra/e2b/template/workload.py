#!/usr/bin/python3 -IS
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
    COORDINATORS.mkdir(mode=0o755, exist_ok=True)
    COORDINATOR_STATE.mkdir(mode=0o755, exist_ok=True)
    immutable(COORDINATORS, True)
    immutable(COORDINATOR_STATE, True)
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
    return {'startTicks': fields[19], 'processGroup': int(fields[2]), 'state': fields[0]}


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


COORDINATORS = ROOT.parent / 'launchpad-coordinators'
COORDINATOR_STATE = Path('/run/launchpad-coordinators')
SERVER = Path('/opt/launchpad/server/t3')


def immutable(path, directory=False):
    info = path.lstat()
    import stat
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_type or info.st_uid != 0 or info.st_mode & 0o022 or (not directory and info.st_nlink != 1):
        raise RuntimeError('Coordinator ownership changed')
    return info


def coordinator_scope(value):
    keys = ('allocationId', 'operationId', 'threadId', 'generation')
    scope = {key: value[key] for key in keys}
    if (any(not isinstance(scope[key], str) or not scope[key] or len(scope[key]) > 1024 for key in keys[:-1])
            or type(scope['generation']) is not int or scope['generation'] < 1):
        raise ValueError('Invalid coordinator scope')
    return scope


def coordinator_id(scope):
    import hashlib
    return hashlib.sha256(json.dumps(coordinator_scope(scope), sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:32]


def sync_json(path, value, mode=0o600):
    import tempfile
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def coordinator_locked():
    if os.getuid() != 0:
        raise RuntimeError('Coordinator control requires root')
    immutable(COORDINATORS, True)
    immutable(COORDINATOR_STATE, True)
    with (COORDINATOR_STATE / 'lock').open('a+') as handle:
        os.fchmod(handle.fileno(), 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def coordinator_record(scope, boot_id):
    group_id = coordinator_id(scope)
    record_path = COORDINATOR_STATE / (group_id + '.json')
    immutable(record_path)
    record = read_json(record_path)
    if record['scope'] != coordinator_scope(scope) or record['bootId'] != boot_id or record['groupId'] != group_id:
        raise RuntimeError('Saved coordinator identity differs')
    group = COORDINATORS / group_id
    immutable(group, True)
    return group, record


def coordinator_admission(scope):
    binding = COORDINATOR_STATE / 'restore-binding.json'
    if binding.exists():
        immutable(binding)
        if coordinator_scope(read_json(binding)['boot']) != coordinator_scope(scope):
            raise RuntimeError('A newer restore owns coordinator admission')


def run_coordinator(receipt, mode):
    import pwd, hashlib
    if not re.fullmatch(r'[a-f0-9]{64}', receipt) or mode not in {'initial', 'move', 'restore'}:
        raise ValueError('Invalid coordinator launch')
    scope = coordinator_scope(json.loads(os.environ['LAUNCHPAD_COORDINATOR_SCOPE']))
    with coordinator_locked():
        coordinator_admission(scope)
        immutable(SERVER)
        group_id = coordinator_id(scope)
        group = COORDINATORS / group_id
        record_path = COORDINATOR_STATE / (group_id + '.json')
        if group.exists():
            immutable(group, True)
            if populated(group):
                prior_group, prior = coordinator_record(scope, BOOT.read_text().strip())
                # A repeat start never creates a second coordinator.
                if process_identity(prior['pid'])['startTicks'] != prior['startTicks']:
                    raise RuntimeError('Coordinator leader changed')
                return
            group.rmdir()
        group.mkdir(mode=0o755)
        record = {'version': 1, 'scope': scope, 'groupId': group_id,
                  'bootId': BOOT.read_text().strip(), 'pid': os.getpid(),
                  'startTicks': process_identity(os.getpid())['startTicks'],
                  'executableSha256': hashlib.sha256(SERVER.read_bytes()).hexdigest()}
        (group / 'cgroup.procs').write_text(str(os.getpid()))
        sync_json(record_path, record, 0o644)
    owner = pwd.getpwnam('user')
    os.setgroups([])
    os.setgid(owner.pw_gid)
    os.setuid(owner.pw_uid)
    os.environ.pop('LAUNCHPAD_COORDINATOR_SCOPE', None)
    os.environ.update(HOME=owner.pw_dir, USER=owner.pw_name, LOGNAME=owner.pw_name)
    os.chdir(owner.pw_dir)
    command = ['/usr/bin/flock', '--nonblock', '--conflict-exit-code', '75', '--no-fork',
               '/home/user/.launchpad/thread-server.lock', str(SERVER), '__thread-vm-serve',
               '--receipt-sha256', receipt]
    if mode != 'initial':
        command.append('--' + mode)
    os.execv(command[0], command)


def stop_coordinator(scope, boot_id):
    import hashlib, signal
    group, record = coordinator_record(scope, boot_id)
    own_group = Path('/proc/self/cgroup').read_text().strip().split('::', 1)[-1]
    if own_group == str(group).removeprefix('/sys/fs/cgroup') or own_group.startswith(str(group).removeprefix('/sys/fs/cgroup') + '/'):
        raise RuntimeError('Restore control cannot stop its own transport group')
    try:
        identity = process_identity(record['pid'])
    except FileNotFoundError:
        identity = None
    if identity is not None and identity['startTicks'] != record['startTicks']:
        if populated(group):
            raise RuntimeError('Coordinator PID was reused while children remain')
        return
    if identity is not None and identity['state'] not in {'Z', 'X'}:
        membership = Path(f"/proc/{record['pid']}/cgroup").read_text().strip().split('::', 1)[-1]
        if membership != str(group).removeprefix('/sys/fs/cgroup'):
            raise RuntimeError('Coordinator escaped its captured group')
        if (identity['startTicks'] != record['startTicks']
                or Path(f"/proc/{record['pid']}/exe").resolve() != SERVER.resolve()
                or hashlib.sha256(SERVER.read_bytes()).hexdigest() != record['executableSha256']):
            raise RuntimeError('Coordinator process identity changed')
        descriptor = os.pidfd_open(record['pid'])
        try:
            if process_identity(record['pid'])['startTicks'] != record['startTicks']:
                raise RuntimeError('Coordinator process changed before stop')
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        finally:
            os.close(descriptor)
        try:
            wait_cgroup_event(group, 'populated', '0')
        except RuntimeError:
            pass
    if populated(group):
        (group / 'cgroup.kill').write_text('1')
        wait_cgroup_event(group, 'populated', '0')
    if populated(group):
        raise RuntimeError('Coordinator stop is unconfirmed')


def prepare_warm_restore(value):
    import hashlib
    boot, source = value['boot'], value['source']
    target_scope = coordinator_scope(boot)
    source_scope = coordinator_scope(source)
    if (boot['version'] != 1 or target_scope['threadId'] != source_scope['threadId']
            or target_scope['generation'] <= source_scope['generation']
            or target_scope['operationId'] == source_scope['operationId']
            or type(source['sealEpoch']) is not int or source['sealEpoch'] < 1):
        raise RuntimeError('Warm restore scope differs')
    source_operation = hashlib.sha256(source['captureOperationId'].encode()).hexdigest()[:32]
    target_operation = hashlib.sha256(boot['operationId'].encode()).hexdigest()[:32]
    with coordinator_locked(), locked() as gate:
        if gate['bootId'] != source['bootId'] or not inventory(gate)['stopped']:
            raise RuntimeError('Saved source is not stopped')
        rebound = gate.get('warmRestore') == value
        if rebound:
            if gate['sealedBy'] != target_operation or gate['epoch'] != source['sealEpoch'] + 1:
                raise RuntimeError('Restored workload gate changed')
        elif (gate['sealedBy'] != source_operation or gate['epoch'] != source['sealEpoch']):
            raise RuntimeError('Saved source seal differs')
        stop_coordinator(source_scope, source['bootId'])
        # Root-owned admission also blocks a late old start between this command
        # and identity rotation; the user-owned workload gate alone is insufficient.
        sync_json(COORDINATOR_STATE / 'restore-binding.json', value)
        if not rebound:
            gate.update(sealedBy=target_operation, epoch=source['sealEpoch'] + 1, warmRestore=value)
            sync_json(STATE / 'gate.json', gate, 0o600)
        # A retry also repairs a crash between atomic replacement and ownership.
        import pwd
        owner = pwd.getpwnam('user')
        os.chown(STATE / 'gate.json', owner.pw_uid, owner.pw_gid)
        return {'bootId': gate['bootId'], 'targetSealEpoch': gate['epoch'],
                'coordinatorStopped': True, 'sealRebound': True}


def main(args):
    action = args[0]
    if action == "initialize" and len(args) == 1:
        initialize()
        return
    if action == 'coordinator-run' and len(args) == 3:
        run_coordinator(args[1], args[2])
        return
    if action == 'prepare-warm-restore' and len(args) == 1:
        print(json.dumps(prepare_warm_restore(json.load(sys.stdin))))
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
