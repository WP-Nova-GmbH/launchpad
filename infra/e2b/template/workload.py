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
import subprocess
import sys
import time

ROOT = Path("/sys/fs/cgroup/user/launchpad-workloads")
STATE = Path("/run/launchpad-workloads")
BOOT = Path("/proc/sys/kernel/random/boot_id")
IDENTIFIER = re.compile(r"[a-f0-9]{32}\Z")
KINDS = {"process", "provider", "terminal"}
COORDINATOR_UID = 1000
WORKFLOW_MARKER = Path('/etc/launchpad/workflow-guest')
WORKFLOW_EXEC = '/opt/launchpad/bin/launchpad-workload-exec'
WORKFLOW_UID = 10001
DUMP_POLICY = Path('/proc/sys/fs/suid_dumpable')
WORKFLOW_NATIVE_MODE = 0o751
CHECKPOINT_PYTHON = Path('/opt/launchpad/bin/launchpad-workflow-reader-python')
CHECKPOINT_READER = Path('/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py')
WORKFLOW_GIT = Path('/opt/launchpad/bin/launchpad-workflow-git')
RESOURCE_MONITOR = Path('/opt/launchpad/server/resource-monitor/t3-resource-monitor')
WORKFLOW_SETUP_OWNER = Path('/opt/launchpad/bin/launchpad-workflow-setup-owner')


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
    if os.geteuid() == 0:
        owner = STATE.stat()
        os.chown(temporary, owner.st_uid, owner.st_gid)
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


def pinned_native():
    manifest = Path('/opt/launchpad/codex-native.json')
    immutable(manifest)
    native = read_json(manifest)
    executable = Path(native['executable'])
    info = immutable(executable)
    if native['version'] != '0.159.3' or not info.st_mode & 0o111:
        raise RuntimeError('Native executable identity changed')
    return native, executable, info


def workflow_native():
    native, executable, info = pinned_native()
    require_workflow_executable(info)
    return native, executable, info


def require_workflow_executable(info):
    import stat
    if info.st_gid != COORDINATOR_UID or stat.S_IMODE(info.st_mode) != WORKFLOW_NATIVE_MODE:
        raise RuntimeError('Workflow executable is not execute-only for workloads')


def native_identity(gate, work_id, pid):
    import hashlib
    native, executable, info = pinned_native()
    if (not os.path.samestat(info, Path(f'/proc/{pid}/exe').stat())
            or hashlib.sha256(executable.read_bytes()).hexdigest() != native['sha256']):
        raise RuntimeError('Native executable identity changed')
    record = read_json(STATE / (work_id + '.json'))
    stat = process_identity(pid)
    if (record['id'] != work_id or record['kind'] != 'provider' or record['leaderPid'] != pid
            or record['bootId'] != gate['bootId'] or record['startTicks'] != stat['startTicks']
            or (workflow_guest() and record.get('workflow') is not True)
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


def signal_workflow(gate, work_id, pid, signal_name):
    import signal
    signals = {'HUP': signal.SIGHUP, 'INT': signal.SIGINT, 'TERM': signal.SIGTERM, 'KILL': signal.SIGKILL}
    if signal_name not in signals or pid <= 1:
        raise ValueError('Invalid workflow signal')
    group = ROOT / identifier(work_id)
    if not group.exists():
        return False
    record = read_json(STATE / (work_id + '.json'))
    if (record['id'] != work_id or record['bootId'] != gate['bootId'] or record['leaderPid'] != pid
            or record.get('workflow') is not True):
        raise RuntimeError('Workflow workload identity changed')
    if not populated(group):
        return False
    if signal_name == 'KILL':
        (group / 'cgroup.kill').write_text('1')
        return True
    try:
        pidfd = os.pidfd_open(pid)
    except ProcessLookupError:
        return False
    try:
        if (process_identity(pid)['startTicks'] != record['startTicks']
                or str(pid) not in (group / 'cgroup.procs').read_text().split()):
            return False
        signal.pidfd_send_signal(pidfd, signals[signal_name])
        return True
    except (FileNotFoundError, ProcessLookupError):
        return False
    finally:
        os.close(pidfd)


def require_workflow_dump_policy(configure=False):
    if configure and DUMP_POLICY.read_text().strip() != '0':
        DUMP_POLICY.write_text('0\n')
    if DUMP_POLICY.read_text().strip() != '0':
        raise RuntimeError('Workflow process memory protection is unavailable')


def native_peer_control(action, pidfd, *args):
    return subprocess.run(
        [WORKFLOW_EXEC, action, str(pidfd), *map(str, args)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={'LC_ALL': 'C'}, pass_fds=(pidfd,), timeout=3,
    ).returncode


def require_workflow_peer_support():
    require_workflow_dump_policy(configure=True)
    # Verify the actual cross-UID syscall and guest kernel policy before using
    # this template. A self-pidfd probe would bypass ptrace permission checks.
    with subprocess.Popen(
        ['/usr/bin/cat'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        user=WORKFLOW_UID, group=WORKFLOW_UID, extra_groups=[], env={'LC_ALL': 'C'}, cwd='/',
    ) as child:
        pidfd = os.pidfd_open(child.pid)
        try:
            if native_peer_control('probe-workflow-provider-pidfd', pidfd) != 0:
                raise RuntimeError('Workflow socket attribution is unavailable')
        finally:
            os.close(pidfd)


def verify_workflow_provider_peer(gate, work_id, pid, start_ticks, listener_port, client_port):
    require_workflow_dump_policy()
    if (pid <= 1 or not start_ticks.isdecimal() or len(start_ticks) > 20
            or not 1 <= listener_port <= 65535 or not 1 <= client_port <= 65535
            or listener_port == client_port):
        raise ValueError('Invalid workflow provider peer')
    group = ROOT / identifier(work_id)
    try:
        record = read_json(STATE / (work_id + '.json'))
        if (record['id'] != work_id or record['bootId'] != gate['bootId'] or record['kind'] != 'provider'
                or record['leaderPid'] != pid or record['startTicks'] != start_ticks
                or record.get('workflow') is not True):
            return False
        _, _, expected_executable = workflow_native()
        pidfd = os.pidfd_open(pid)
        try:
            def still_provider():
                identity = process_identity(pid)
                proc = Path(f'/proc/{pid}')
                owner = proc.stat()
                environment = (proc / 'environ').stat()
                return (identity['startTicks'] == start_ticks and identity['processGroup'] == pid
                        and str(pid) in (group / 'cgroup.procs').read_text().split()
                        and (owner.st_uid, owner.st_gid) == (WORKFLOW_UID, WORKFLOW_UID)
                        and environment.st_uid == 0 and environment.st_mode & 0o077 == 0
                        and os.path.samestat(expected_executable, (proc / 'exe').stat()))

            if not still_provider():
                return False
            result = native_peer_control('inspect-workflow-provider-socket', pidfd, pid, listener_port, client_port)
            if result not in {0, 1}:
                raise RuntimeError('Workflow socket attribution is unavailable')
            require_workflow_dump_policy()
            return result == 0 and still_provider()
        finally:
            os.close(pidfd)
    except (FileNotFoundError, ProcessLookupError):
        return False


def native_setup_control(*args):
    immutable(RESOURCE_MONITOR)
    response = subprocess.run(
        [str(RESOURCE_MONITOR), '--workflow-setup-process', *map(str, args)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/', check=True, timeout=7,
    )
    receipt = json.loads(response.stdout)
    if receipt['protocol'] != 4:
        raise RuntimeError('Workflow setup control receipt changed')
    return receipt


def setup_cgroup_id(pid):
    prefix = '0::' + str(ROOT).removeprefix('/sys/fs/cgroup') + '/'
    membership = Path(f'/proc/{pid}/cgroup').read_text().strip()
    if not membership.startswith(prefix):
        raise RuntimeError('Workflow setup owner has no exact cgroup')
    return identifier(membership.removeprefix(prefix))


def setup_cgroup_record(gate, work_id, pid, ticks):
    group = ROOT / identifier(work_id)
    path = STATE / (work_id + '.json')
    record = read_json(path) if path.exists() else None
    if record != {
            'id': work_id, 'kind': 'terminal', 'leaderPid': pid, 'startTicks': ticks,
            'bootId': gate['bootId'], 'workflow': True, 'setupOwner': True}:
        # Only inventory removes groups and only after the kernel confirms they
        # are empty. A previously captured identity remains valid on lost ACK.
        if record is None and not group.exists():
            return None
        raise RuntimeError('Workflow setup cgroup ownership changed')
    return group


def require_live_setup_owner(gate, work_id, pid, ticks):
    group = setup_cgroup_record(gate, work_id, pid, ticks)
    require_workflow_dump_policy()
    expected = immutable(WORKFLOW_SETUP_OWNER)
    require_workflow_executable(expected)
    proc = Path(f'/proc/{pid}')
    owner = proc.stat()
    environment = (proc / 'environ').stat()
    identity = process_identity(pid)
    if (group is None or setup_cgroup_id(pid) != work_id or identity['startTicks'] != ticks
            or identity['state'] in {'Z', 'X'} or str(pid) not in (group / 'cgroup.procs').read_text().split()
            or (owner.st_uid, owner.st_gid) != (WORKFLOW_UID, WORKFLOW_UID)
            or environment.st_uid != 0 or environment.st_mode & 0o077
            or not os.path.samestat(expected, (proc / 'exe').stat())):
        raise RuntimeError('Workflow setup owner identity changed')
    return group


def workflow_setup_control(args):
    if os.getuid() != 0 or not workflow_guest():
        raise RuntimeError('Workflow setup control is unavailable')
    operation = args[0]
    if operation == 'host' and len(args) == 1:
        return native_setup_control('host')
    if (operation, len(args)) not in {('capture', 2), ('arm', 3), ('stop', 3)}:
        raise ValueError('Invalid workflow setup control')
    pid = int(args[1])
    if pid <= 1:
        raise ValueError('Invalid workflow setup PID')
    if operation == 'capture':
        # node-pty may acknowledge before the launcher enters its cgroup. The
        # native readiness wait must leave the gate free for registration.
        receipt = native_setup_control('capture', pid)
        boot, ticks = receipt['identity'].split(':')
        if not receipt['owned'] or receipt['fullStop']:
            raise RuntimeError('Workflow setup capture is unavailable')
        work_id = setup_cgroup_id(pid)
        with locked() as gate:
            if boot != gate['bootId']:
                raise RuntimeError('Workflow setup boot changed')
            require_live_setup_owner(gate, work_id, pid, ticks)
        return {**receipt, 'identity': f'workflow-vm:{work_id}:{boot}:{ticks}'}
    prefix, work_id, boot, ticks = args[2].split(':')
    if prefix != 'workflow-vm' or not re.fullmatch(r'[0-9]{1,20}', ticks):
        raise ValueError('Invalid captured workflow setup identity')
    identifier(work_id)
    with locked() as gate:
        if boot != gate['bootId']:
            raise RuntimeError('Workflow setup boot changed')
        if operation == 'stop':
            group = setup_cgroup_record(gate, work_id, pid, ticks)
            if group is not None and group.exists() and populated(group):
                (group / 'cgroup.kill').write_text('1')
                wait_cgroup_event(group, 'populated', '0', seconds=5)
            return {'protocol': 4, 'identity': None, 'owned': True, 'fullStop': True, 'boot': None}
        if gate['sealedBy'] is not None:
            raise RuntimeError('Workload launches are sealed')
        group = require_live_setup_owner(gate, work_id, pid, ticks)
        try:
            receipt = native_setup_control('arm', pid, f'{boot}:{ticks}')
            if receipt['identity'] != f'{boot}:{ticks}':
                raise RuntimeError('Workflow setup arm identity changed')
        except Exception:
            # The owner may have received arm before the reply failed. Kill the
            # group before releasing the seal lock so it cannot start afterward.
            (group / 'cgroup.kill').write_text('1')
            wait_cgroup_event(group, 'populated', '0')
            raise
        return {**receipt, 'identity': args[2]}


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


def workflow_guest():
    try:
        immutable(WORKFLOW_MARKER)
    except FileNotFoundError:
        return False
    immutable(WORKFLOW_MARKER.parent, True)
    if read_json(WORKFLOW_MARKER) != {'version': 1}:
        raise RuntimeError('Invalid workflow guest marker')
    return True


def exec_coordinator(command, workflow=False):
    import pwd
    owner = pwd.getpwnam('user')
    if workflow and (owner.pw_uid != COORDINATOR_UID or owner.pw_gid != COORDINATOR_UID):
        raise RuntimeError('Invalid workflow coordinator identity')
    os.setgroups([])
    os.setgid(owner.pw_gid)
    os.setuid(owner.pw_uid)
    os.environ.pop('LAUNCHPAD_COORDINATOR_SCOPE', None)
    os.environ.pop('LAUNCHPAD_WORKFLOW_GUEST', None)
    if workflow:
        os.environ['LAUNCHPAD_WORKFLOW_GUEST'] = '1'
    os.environ.update(HOME=owner.pw_dir, USER=owner.pw_name, LOGNAME=owner.pw_name)
    os.chdir(owner.pw_dir)
    os.execv(command[0], command)


def enroll_workflow():
    if os.getuid() != 0:
        raise RuntimeError('Workflow enrollment requires root')
    with coordinator_locked():
        require_workflow_peer_support()
        _, executable, _ = pinned_native()
        os.chown(executable, 0, COORDINATOR_UID)
        os.chmod(executable, WORKFLOW_NATIVE_MODE)
        workflow_native()
        workspace = os.open('/workspace', os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        try:
            info = os.fstat(workspace)
            if (info.st_uid, info.st_gid) != (COORDINATOR_UID, COORDINATOR_UID):
                raise RuntimeError('Invalid workflow workspace parent')
            os.fchmod(workspace, 0o755)
        finally:
            os.close(workspace)
        for path in ('/home/user', '/home/user/.launchpad', '/home/user/.codex'):
            directory = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
            try:
                info = os.fstat(directory)
                if (info.st_uid, info.st_gid) != (COORDINATOR_UID, COORDINATOR_UID):
                    raise RuntimeError('Invalid workflow coordinator directory')
                os.fchmod(directory, 0o700)
            finally:
                os.close(directory)
        WORKFLOW_MARKER.parent.mkdir(mode=0o755, exist_ok=True)
        immutable(WORKFLOW_MARKER.parent, True)
        # A private umask is appropriate for enrollment state, but the coordinator
        # must be able to traverse the root-owned directory containing this marker.
        WORKFLOW_MARKER.parent.chmod(0o755)
        if not workflow_guest():
            sync_json(WORKFLOW_MARKER, {'version': 1}, 0o644)
    exec_coordinator(['/usr/bin/flock', '--no-fork', '-x', '/home/user/.launchpad-enrollment.lock',
                      str(SERVER), '__thread-vm-enroll', '--base-dir', '/home/user/.launchpad'])


def run_coordinator(receipt, mode):
    import hashlib
    if not re.fullmatch(r'[a-f0-9]{64}', receipt) or mode not in {'initial', 'move', 'restore'}:
        raise ValueError('Invalid coordinator launch')
    workflow = workflow_guest()
    if workflow and mode != 'initial':
        raise ValueError('Invalid workflow coordinator launch')
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
    command = ['/usr/bin/flock', '--nonblock', '--conflict-exit-code', '75', '--no-fork',
               '/home/user/.launchpad/thread-server.lock', str(SERVER), '__thread-vm-serve',
               '--receipt-sha256', receipt]
    if mode != 'initial':
        command.append('--' + mode)
    exec_coordinator(command, workflow)


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
    if action == 'workflow-enroll' and len(args) == 1:
        enroll_workflow()
        return
    if action == 'coordinator-run' and len(args) == 3:
        run_coordinator(args[1], args[2])
        return
    if action == 'prepare-warm-restore' and len(args) == 1:
        print(json.dumps(prepare_warm_restore(json.load(sys.stdin))))
        return
    if action in {"run", "run-transfer", "run-workflow"}:
        transfer = action == "run-transfer"
        workflow = action == "run-workflow"
        if workflow and (os.getuid() != COORDINATOR_UID or not workflow_guest()):
            raise RuntimeError('Workflow workload admission is unavailable')
        if transfer:
            _, boot_id, operation_id, epoch, work_id, separator, *command = args
            identifier(operation_id)
            kind = "transfer"
        elif workflow:
            _, work_id, kind, cwd, separator, *command = args
            if cwd and not os.path.isabs(cwd):
                raise ValueError('Invalid workflow working directory')
        else:
            _, work_id, kind, separator, *command = args
        identifier(work_id)
        if (not transfer and kind not in KINDS) or separator != "--" or not command:
            raise ValueError("Invalid workload command")
        setup_owner = (workflow and kind == 'terminal'
                       and command[:3] == [str(RESOURCE_MONITOR), '--setup-owner-v4', '--script-file-v1'])
        if setup_owner and len(command) != 4:
            raise ValueError('Invalid workflow setup owner launch')
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
                **({"workflow": True} if workflow else {}),
                **({"setupOwner": True} if setup_owner else {}),
            })
            (group / "cgroup.procs").write_text(str(os.getpid()))
        # The native helper enters the requested workflow directory after dropping UID.
        if workflow:
            if setup_owner:
                require_workflow_dump_policy()
                require_workflow_executable(immutable(WORKFLOW_SETUP_OWNER))
                os.execv(WORKFLOW_EXEC, [WORKFLOW_EXEC, 'exec-setup-owner', cwd, command[3]])
            if kind == 'process' and command[0] in {'git', '/usr/bin/git'}:
                require_workflow_dump_policy()
                require_workflow_executable(immutable(WORKFLOW_GIT))
                os.execv(WORKFLOW_EXEC, [WORKFLOW_EXEC, 'exec-git', cwd, '--', *command[1:]])
            if kind == 'process' and command[:3] == ['/usr/bin/python3', '-IS', str(CHECKPOINT_READER)]:
                require_workflow_dump_policy()
                if len(command) != 4 or command[3] not in {'capture', 'exclude'}:
                    raise RuntimeError('Invalid workflow checkpoint reader launch')
                require_workflow_executable(immutable(CHECKPOINT_PYTHON))
                immutable(CHECKPOINT_READER)
                os.execv(WORKFLOW_EXEC, [WORKFLOW_EXEC, 'exec-checkpoint-reader', cwd, command[3]])
            if kind == 'provider':
                require_workflow_dump_policy()
                _, executable, _ = workflow_native()
                if command[0] not in {'codex', '/usr/bin/codex', '/opt/launchpad/node/bin/codex', str(executable)}:
                    raise RuntimeError('Workflow providers require the packaged native Codex')
                # No readable shell shim may run as the workload UID before
                # the execute-only native binary takes over the tracked PID.
                os.execv(WORKFLOW_EXEC, [WORKFLOW_EXEC, 'exec-provider', cwd, '--', str(executable), *command[1:]])
            os.execv(WORKFLOW_EXEC, [WORKFLOW_EXEC, 'exec', cwd, '--', *command])
        os.execvpe(command[0], command, os.environ)
    if action in {'provider-identity', 'stop-idle-provider', 'signal-workflow', 'verify-workflow-provider-peer', 'workflow-setup-control'} and os.getuid() == COORDINATOR_UID and workflow_guest():
        os.execv(WORKFLOW_EXEC, [WORKFLOW_EXEC, *args])
    if action == 'workflow-setup-control':
        print(json.dumps(workflow_setup_control(args[1:])))
        return
    with locked() as gate:
        if action == 'verify-workflow-provider-peer' and len(args) == 6:
            if os.getuid() != 0 or not workflow_guest():
                raise RuntimeError('Workflow socket attribution is unavailable')
            _, work_id, pid, start_ticks, listener_port, client_port = args
            matched = verify_workflow_provider_peer(gate, work_id, int(pid), start_ticks, int(listener_port), int(client_port))
            print(json.dumps({'matched': matched}))
            return
        if action == 'signal-workflow' and len(args) == 4:
            if os.getuid() != 0 or not workflow_guest():
                raise RuntimeError('Workflow signaling is unavailable')
            _, work_id, pid, signal_name = args
            print(json.dumps({'signalled': signal_workflow(gate, work_id, int(pid), signal_name)}))
            return
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
