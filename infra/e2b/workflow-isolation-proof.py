"""Exercise the installed workflow enrollment and workload launcher in a disposable VM."""

import base64
from contextlib import suppress
import errno
import hashlib
import http.server
import json
import os
from pathlib import Path
import selectors
import select
import shlex
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

WORKLOAD = "/opt/launchpad/bin/launchpad-workload"
BROKER = "/opt/launchpad/bin/launchpad-workload-exec"
MARKER = Path("/etc/launchpad/workflow-guest")
CHECKOUT = Path("/workspace/project")
RELAY_CREDENTIAL = Path("/home/user/.launchpad/userdata/secrets/thread-vm-enrollment.bin")
CODEX_CREDENTIAL = Path("/home/user/.codex/auth.json")
CODEX = "/opt/launchpad/node/bin/codex"
CHECKPOINT_READER = Path("/opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py")
WORKFLOW_GIT = Path("/opt/launchpad/bin/launchpad-workflow-git")
SETUP_OWNER = "/opt/launchpad/server/resource-monitor/t3-resource-monitor"
REVIEW_GIT = Path("/home/user/.launchpad/userdata/workflow-review.git")
COORDINATOR = ["/usr/sbin/runuser", "-u", "user", "--"]
CGROUP_ROOT = Path("/sys/fs/cgroup/user/launchpad-workloads")
FIXTURE_CREDENTIAL = "workflow-isolation-proof-credential"


def run(command, **options):
    return subprocess.run(command, text=True, capture_output=True, check=True, timeout=30, **options)


def enroll():
    scope = {
        "allocationId": uuid.uuid4().hex,
        "threadId": uuid.uuid4().hex,
        "repositoryId": uuid.uuid4().hex,
        "generation": 1,
    }
    operation = uuid.uuid4().hex
    seed = uuid.uuid4().hex

    class Enrollment(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/v1/thread-vms/enroll":
                self.send_error(404)
                return
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            body = request["proof"].split(".")[1]
            identity = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            if (identity["seed"], identity["operationId"], identity["allocationId"]) != (
                seed, operation, scope["allocationId"],
            ):
                self.send_error(400)
                return
            response = json.dumps({
                "environmentId": identity["environmentId"],
                "scope": scope,
                "relayIssuer": origin,
                "cloudMintPublicKey": "workflow-isolation-proof-public-key",
                "environmentCredential": FIXTURE_CREDENTIAL,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Enrollment) as relay:
        origin = f"http://127.0.0.1:{relay.server_port}"
        relay_thread = threading.Thread(target=relay.serve_forever, daemon=True)
        relay_thread.start()
        try:
            receipt = json.loads(run([WORKLOAD, "workflow-enroll"], umask=0o077, input=json.dumps({
                "version": 1,
                "operationId": operation,
                "scope": scope,
                "relayUrl": origin,
                "relayIssuer": origin,
                "seed": seed,
            }) + "\n").stdout)
        finally:
            relay.shutdown()
            relay_thread.join()
    assert receipt["enrolled"] and receipt["operationId"] == operation
    assert receipt["threadId"] == scope["threadId"] and receipt["generation"] == 1
    assert json.loads(RELAY_CREDENTIAL.read_text())["environmentCredential"] == FIXTURE_CREDENTIAL


def denied(action, description):
    try:
        action()
    except PermissionError:
        return
    raise AssertionError(f"Workload reached {description}")


def open_for_write(path):
    os.close(os.open(path, os.O_WRONLY))


def deny_envd_request(request, streaming=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=3) as response:
            assert streaming, "envd allowed an unauthenticated root file read"
            flag, length = struct.unpack(">BI", response.read(5))
            assert flag == 2 and length <= 4096, "envd accepted an unauthenticated root command"
            error = json.loads(response.read(length))["error"]["code"]
            assert error in {"unauthenticated", "permission_denied"}, "Unexpected envd response"
    except urllib.error.HTTPError as error:
        assert error.code in {401, 403}, f"Unexpected envd HTTP status {error.code}"
    except urllib.error.URLError as error:
        assert isinstance(error.reason, socket.timeout) or getattr(error.reason, "errno", None) in {
            errno.EACCES, errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EPERM,
        }, "Unexpected envd connection error"


def probe_envd(host, target):
    # Match the pinned SDK's root selectors and Connect server-streaming JSON
    # envelope, leaving out its sandbox access token.
    address = f"[{host}]" if ":" in host else host
    origin = f"http://{address}:49983"
    payload = json.dumps({"process": {"cmd": "/usr/bin/touch", "args": [target]}}).encode()
    deny_envd_request(urllib.request.Request(f"{origin}/process.Process/Start", data=(
        struct.pack(">BI", 0, len(payload)) + payload
    ), headers={
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        "Authorization": "Basic " + base64.b64encode(b"root:").decode(),
    }), streaming=True)
    query = urllib.parse.urlencode({"path": str(RELAY_CREDENTIAL), "username": "root"})
    deny_envd_request(f"{origin}/files?{query}")


def workload_probe(pid, credential_fd, work_id, target, *hosts):
    assert os.getresuid() == (10001, 10001, 10001) and os.getresgid() == (10001, 10001, 10001)
    assert os.getgroups() == [] and Path.home() == Path("/home/launchpad-workflow")
    assert os.environ.get("CODEX_HOME") == "/home/launchpad-workflow/.codex"
    assert "T3CODE_HOME" not in os.environ and "LAUNCHPAD_WORKFLOW_GUEST" not in os.environ
    assert Path.cwd() == CHECKOUT
    assert os.environ["PWD"] == str(CHECKOUT)
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    assert status["NoNewPrivs"].strip() == "1"
    assert all(int(status[name].strip(), 16) == 0 for name in ("CapPrm", "CapEff", "CapAmb"))
    assert Path("/proc/self/cgroup").read_text().strip() == f"0::/user/launchpad-workloads/{work_id}"
    for credential in [RELAY_CREDENTIAL, CODEX_CREDENTIAL, Path(f"/proc/{pid}/environ"),
                       Path(f"/proc/{pid}/fd/{credential_fd}")]:
        denied(credential.read_bytes, "coordinator credentials")
    review_config = REVIEW_GIT / "config"
    denied(review_config.read_bytes, "private review Git data")
    denied(lambda: open_for_write(review_config), "private review Git configuration")
    denied(lambda: os.kill(int(pid), 0), "coordinator signalling")
    for path in [MARKER, Path("/run/launchpad-workloads/gate.json"),
                 CGROUP_ROOT / "cgroup.procs", CGROUP_ROOT / work_id / "cgroup.procs"]:
        denied(lambda: open_for_write(path), "workload admission or cgroup control")
    denied(lambda: subprocess.run([BROKER, "prepare-workspace"], check=False, timeout=5),
           "privileged workload broker")
    for host in hosts:
        probe_envd(host, target)
    workspace_probe = CHECKOUT / "workflow-isolation-write"
    workspace_probe.write_text("workspace-ok")
    assert workspace_probe.read_text() == "workspace-ok"
    workspace_probe.unlink()
    run(["/usr/bin/git", "init", "--quiet", "--template="])
    assert (CHECKOUT / ".git/config").is_file()
    print("workflow-isolation-ok")


def wait_for_line(process):
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        assert ready.select(10), "A fixture process did not report its identity"
    return process.stdout.readline().split()


def wait_until_empty(group):
    with (group / "cgroup.events").open() as events:
        poller = select.poll()
        poller.register(events, select.POLLPRI | select.POLLERR)
        deadline = time.monotonic() + 5
        while True:
            events.seek(0)
            if "populated 0" in events.read():
                return
            remaining = deadline - time.monotonic()
            assert remaining > 0, "Workflow cgroup did not stop"
            poller.poll(max(1, int(remaining * 1000)))


def prove_workload_signals():
    # A child that starts a new session must still be stopped by its exact
    # tracked cgroup after the original leader has exited.
    fixture = """
import os, signal
leader = os.getpid()
if not os.fork():
    os.setsid()
    print(leader, os.getpid(), flush=True)
signal.pause()
"""
    launched = []
    try:
        for kind in ("process", "terminal"):
            work_id = uuid.uuid4().hex
            process = subprocess.Popen(
                [WORKLOAD, "run-workflow", work_id, kind, str(CHECKOUT), "--",
                 "/usr/bin/python3", "-c", fixture],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd="/", text=True, user=1000, group=1000, extra_groups=[],
            )
            launched.append((work_id, process))
        (provider, first), (terminal, second) = launched
        leader, detached = wait_for_line(first)
        other_leader, other_detached = wait_for_line(second)
        assert first.pid == int(leader) and second.pid == int(other_leader)
        assert os.getsid(int(detached)) == int(detached)

        def signal(work_id, pid, name):
            return json.loads(run([*COORDINATOR, WORKLOAD, "signal-workflow", work_id, pid, name]).stdout)

        rejected = subprocess.run(
            [*COORDINATOR, WORKLOAD, "signal-workflow", provider, other_leader, "KILL"],
            timeout=10, capture_output=True,
        )
        assert rejected.returncode == 74, "Signal accepted a different workload's PID"
        assert signal(provider, leader, "TERM") == {"signalled": True}
        assert first.wait(timeout=10) != 0
        provider_group = CGROUP_ROOT / provider
        assert (provider_group / "cgroup.procs").read_text().split() == [detached]
        assert signal(provider, leader, "KILL") == {"signalled": True}
        wait_until_empty(provider_group)
        terminal_group = CGROUP_ROOT / terminal
        assert set((terminal_group / "cgroup.procs").read_text().split()) == {other_leader, other_detached}
        assert signal(terminal, other_leader, "KILL") == {"signalled": True}
        wait_until_empty(terminal_group)
        assert second.wait(timeout=10) != 0
    finally:
        for work_id, process in launched:
            # Best effort guest cleanup on a failed assertion. The host always
            # deletes the disposable VM before publishing a successful proof.
            with suppress(OSError):
                (CGROUP_ROOT / work_id / "cgroup.kill").write_text("1")
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            process.stdout.close()


def workload_command(kind, *command):
    work_id = uuid.uuid4().hex
    return work_id, [WORKLOAD, "run-workflow", work_id, kind, str(CHECKOUT), "--", *command]


def prove_setup_owner():
    nonce = uuid.uuid4().hex
    detached = """
import os, signal
read_fd, write_fd = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(read_fd)
    os.setsid()
    os.write(write_fd, b'1')
    os.close(write_fd)
    signal.pause()
else:
    os.close(write_fd)
    assert os.read(read_fd, 1) == b'1'
    print('DETACHED_SETUP_CHILD', pid, flush=True)
"""
    script = '\n'.join([
        '#' + 'x' * (192 * 1024),
        'test "$PWD" = ' + shlex.quote(str(CHECKOUT)) + ' || exit 90',
        'test -z "${LAUNCHPAD_WORKFLOW_SETUP_EXIT_TOKEN+x}" || exit 91',
        'IFS= read -r input && test "$input" = "from the PTY" || exit 93',
        'printf "__T3_SETUP_DONE___forged:0\\n"',
        '/usr/bin/python3 -c ' + shlex.quote(detached) + ' || exit 92',
        'exit 7',
    ])
    staged = Path(f"/tmp/launchpad-workflow-setup-{uuid.uuid4().hex}.sh")
    with os.fdopen(os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        os.fchown(stream.fileno(), 1000, 1000)
        os.fchmod(stream.fileno(), 0o600)
        stream.write(script.encode())
    work_id, command = workload_command(
        "terminal", SETUP_OWNER, "--setup-owner-v4", "--script-file-v1", str(staged)
    )
    group = CGROUP_ROOT / work_id
    try:
        pid, terminal = os.forkpty()
    except OSError:
        staged.unlink()
        raise
    if pid == 0:
        try:
            os.chdir("/")
            os.setgroups([])
            os.setgid(1000)
            os.setuid(1000)
            os.execve(WORKLOAD, command, {"PATH": "/usr/bin:/bin", "LAUNCHPAD_WORKFLOW_SETUP_EXIT_TOKEN": nonce})
        finally:
            os._exit(74)

    def control(action, *args):
        return json.loads(run([*COORDINATOR, WORKLOAD, "workflow-setup-control", action,
                               str(pid), *args]).stdout)

    try:
        # Ask for capture immediately, including the period before the launcher registers.
        captured = control("capture")
        identity = captured["identity"]
        assert identity.startswith(f"workflow-vm:{work_id}:") and captured["owned"]
        assert not staged.exists(), "Setup script remained on disk after owner capture"
        argv = Path(f"/proc/{pid}/cmdline").read_bytes()
        assert nonce.encode() not in argv and str(staged).encode() not in argv
        _, spoof = workload_command("process", "/usr/bin/python3", "-c", """
from pathlib import Path
import socket, sys
pid = sys.argv[1]
try:
    Path(f'/proc/{pid}/environ').read_bytes()
except PermissionError:
    pass
else:
    raise AssertionError('Workload can read the setup owner nonce')
path, = Path('/tmp').glob(f't3-setup-v4-{pid}-*')
with socket.socket(socket.AF_UNIX) as peer:
    peer.settimeout(3)
    try:
        peer.connect(str(path))
        peer.sendall(b'A')
        assert peer.recv(128) == b'', 'Workload armed the setup owner'
    except (ConnectionResetError, BrokenPipeError, PermissionError):
        pass
""", str(pid))
        run(spoof, cwd="/", user=1000, group=1000, extra_groups=[])
        receipt = control("arm", identity)
        assert receipt["launch"]["selectedShell"] == "/bin/bash" and receipt["identity"] == identity
        os.write(terminal, b"from the PTY\n")
        frame = f"\x1b]T3_SETUP_EXIT;{nonce};7\x07".encode()
        output = b""
        deadline = time.monotonic() + 10
        while frame not in output:
            remaining = deadline - time.monotonic()
            assert remaining > 0 and select.select([terminal], [], [], remaining)[0], "Missing setup exit receipt"
            output += os.read(terminal, 4096)
            assert len(output) < 65536
        assert b"__T3_SETUP_DONE___forged:0" in output
        line = next(line for line in output.splitlines() if line.startswith(b"DETACHED_SETUP_CHILD "))
        detached_pid = int(line.split()[1])
        assert os.getsid(detached_pid) == detached_pid
        assert str(detached_pid) in (group / "cgroup.procs").read_text().split()
        for _ in range(2):
            stopped = control("stop", identity)
            assert stopped["fullStop"] and stopped["owned"] and stopped["identity"] is None
        wait_until_empty(group)
    finally:
        staged.unlink(missing_ok=True)
        os.close(terminal)
        with suppress(OSError):
            (group / "cgroup.kill").write_text("1")
        with suppress(ProcessLookupError):
            os.kill(pid, 9)
        os.waitpid(pid, 0)


def prove_private_checkpoint_reader():
    assert CHECKPOINT_READER.stat().st_uid == 0 and not CHECKPOINT_READER.stat().st_mode & 0o022
    assert hashlib.sha256(CHECKPOINT_READER.read_bytes()).hexdigest() == os.environ[
        "LAUNCHPAD_CHECKPOINT_READER_SHA256"
    ]
    git_info = WORKFLOW_GIT.stat()
    assert (git_info.st_uid, git_info.st_gid, stat.S_IMODE(git_info.st_mode)) == (0, 1000, 0o751)
    options = dict(cwd="/", user=1000, group=1000, extra_groups=[])
    _, setup = workload_command("process", "/usr/bin/python3", "-c", """
from pathlib import Path
import os
os.umask(0o077)
for name in ('private', '.git', '.git/info'):
    Path(name).mkdir(exist_ok=True)
    os.chmod(name, 0o700)
Path('private/proof.txt').write_bytes(b'private bytes')
Path('.git/info/exclude').write_bytes(b'ignored\\n')
Path('ignored').touch()
""")
    run(setup, **options)
    for path in ("private/proof.txt", ".git/info/exclude"):
        denied_read = subprocess.run(["/usr/bin/cat", str(CHECKOUT / path)], capture_output=True, **options)
        assert denied_read.returncode != 0, "Coordinator could read private workload data"

    def read(action, data=b""):
        _, command = workload_command("process", "/usr/bin/python3", "-IS", str(CHECKPOINT_READER), action)
        return subprocess.run(command, input=data, capture_output=True, check=True, timeout=10, **options).stdout

    def record(kind, path, contents=b""):
        return struct.pack(">BIQ", kind, len(path), len(contents)) + path + contents

    _, listing = workload_command("process", "/usr/bin/git", "ls-files", "--others", "--exclude-standard", "-z")
    candidates = run(listing, **options).stdout.encode()
    assert candidates == b"private/proof.txt\0"
    assert read("capture", candidates) == (
        record(5, b"private") + record(1, b"private/proof.txt", b"private bytes") + record(0, b"")
    )
    assert read("exclude") == b"ignored\n"


def prove_native_codex_peer():
    options = dict(cwd="/", user=1000, group=1000, extra_groups=[])
    permit = uuid.uuid4().hex
    recognized = threading.Event()
    rejected_plugin = threading.Event()
    provider = None
    identity = None

    class Inference(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/v1/responses" or self.headers.get("Authorization") != f"Bearer {permit}":
                self.send_error(401)
                return
            result = run([*COORDINATOR, WORKLOAD, "verify-workflow-provider-peer",
                          work_id, str(provider.pid), identity["startTicks"],
                          str(self.server.server_port), str(self.client_address[1])])
            if not json.loads(result.stdout)["matched"]:
                if self.headers.get("X-Workflow-Proof") == "planted-mcp":
                    rejected_plugin.set()
                self.send_error(401)
                return
            recognized.set()
            # This proves the native caller without using an account or public network.
            self.send_error(400, "Offline smoke request received")

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Inference) as proxy:
        origin = f"http://127.0.0.1:{proxy.server_port}/v1"
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        proxy_thread.start()
        model_policy = json.loads(run(["/opt/launchpad/server/t3", "__thread-vm-codex-model-policy"], **options).stdout)
        app_args = [value.replace("http://127.0.0.1:1/v1", origin).replace(
            'command="/usr/bin/false",args=[]',
            'command="/usr/bin/printenv",args=["LAUNCHPAD_WORKFLOW_CODEX_PERMIT"]',
        ) for value in model_policy["probeArgs"]]
        # A previous step can change the shared home and get a command to run
        # when the next Codex starts. Even it cannot use a copied permit.
        plugin = """
import sys, urllib.error, urllib.request
req = urllib.request.Request(sys.argv[1] + '/responses', data=b'{}', headers={
    'Authorization': 'Bearer ' + sys.argv[2], 'X-Workflow-Proof': 'planted-mcp',
})
try:
    urllib.request.urlopen(req, timeout=10)
except urllib.error.HTTPError as error:
    assert error.code == 401
"""
        _, plant = workload_command("process", "/usr/bin/python3", "-c", """
from pathlib import Path
import sys
Path.home().joinpath('.codex', 'config.toml').write_text(sys.stdin.read())
""")
        run(plant, input=(
            '[mcp_servers.planted]\ncommand = "/usr/bin/python3"\nstartup_timeout_sec = 5\n'
            + 'args = ' + json.dumps(["-c", plugin, origin, permit]) + '\n'
        ), **options)
        work_id, command = workload_command("provider", CODEX, *app_args)
        try:
            with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, start_new_session=True, **options, env={
                                      "PATH": "/usr/bin:/bin", "LAUNCHPAD_WORKFLOW_CODEX_PERMIT": permit,
                                  }) as provider:
                try:
                    def send(message):
                        provider.stdin.write(json.dumps(message).encode() + b"\n")
                        provider.stdin.flush()

                    pending = b""

                    def reply(request_id):
                        nonlocal pending
                        with selectors.DefaultSelector() as ready:
                            ready.register(provider.stdout, selectors.EVENT_READ)
                            deadline = time.monotonic() + 15
                            while True:
                                if b"\n" in pending:
                                    line, pending = pending.split(b"\n", 1)
                                    message = json.loads(line)
                                    if message.get("id") == request_id:
                                        assert "result" in message, f"Pinned Codex RPC {request_id} failed"
                                        return message["result"]
                                    continue
                                remaining = deadline - time.monotonic()
                                assert remaining > 0 and ready.select(remaining), "Pinned Codex RPC timed out"
                                chunk = os.read(provider.stdout.fileno(), 65536)
                                assert chunk, "Pinned Codex exited during RPC"
                                pending += chunk

                    send({"id": 1, "method": "initialize", "params": {
                        "clientInfo": {"name": "launchpad_workflow_smoke", "version": "1"},
                        "capabilities": {"experimentalApi": True},
                    }})
                    reply(1)
                    identity = json.loads(run([*COORDINATOR, WORKLOAD, "provider-identity", work_id,
                                               str(provider.pid)]).stdout)

                    _, attacker = workload_command("process", "/usr/bin/python3", "-c", """
from pathlib import Path
import sys, urllib.error, urllib.request
pid, url, permit = sys.argv[1:]
try:
    Path(f'/proc/{pid}/environ').read_bytes()
except PermissionError:
    pass
else:
    raise AssertionError('Other workloads can inspect native Codex')
request = urllib.request.Request(url + '/responses', data=b'{}', headers={'Authorization': 'Bearer ' + permit})
try:
    urllib.request.urlopen(request, timeout=10)
except urllib.error.HTTPError as error:
    assert error.code == 401
else:
    raise AssertionError('Other workloads can use a copied permit')
""", str(provider.pid), origin, permit)
                    run(attacker, **options)

                    send({"method": "initialized"})
                    send({"id": 2, "method": "thread/start", "params": {
                        "cwd": str(CHECKOUT), "model": model_policy["defaultModel"],
                        "approvalPolicy": "never", "sandbox": "danger-full-access",
                    }})
                    thread = reply(2)["thread"]
                    send({"id": 3, "method": "turn/start", "params": {
                        "threadId": thread["id"],
                        "input": [{"type": "text", "text": "Workflow inference smoke", "text_elements": []}],
                    }})
                    assert recognized.wait(20), "The pinned Codex peer could not reach the workflow proxy"
                    assert rejected_plugin.wait(5), "A planted Codex command was not shown to fail peer verification"
                finally:
                    if provider.poll() is None:
                        (CGROUP_ROOT / work_id / "cgroup.kill").write_text("1")
                    provider.wait(timeout=5)
        finally:
            proxy.shutdown()
            proxy_thread.join()


def proof():
    assert os.getuid() == 0 and not MARKER.exists()
    # The real coordinator launches from a sibling of the workload hierarchy.
    # This fixture starts as root, so place it in the same parent before dropping UID.
    coordinator_group = CGROUP_ROOT.parent / "launchpad-coordinators" / uuid.uuid4().hex
    coordinator_group.mkdir()
    (coordinator_group / "cgroup.procs").write_text(str(os.getpid()))
    broker_info = Path(BROKER).lstat()
    assert stat.S_ISREG(broker_info.st_mode) and broker_info.st_uid == 0
    assert broker_info.st_gid == 1000 and stat.S_IMODE(broker_info.st_mode) == 0o4750
    enroll()
    marker_info = MARKER.lstat()
    assert stat.S_ISREG(marker_info.st_mode) and marker_info.st_uid == 0
    assert stat.S_IMODE(marker_info.st_mode) == 0o644
    run([*COORDINATOR, "/usr/bin/python3", "-c", (
        f"import os; fd=os.open({str(CODEX_CREDENTIAL)!r}, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600);"
        "os.write(fd, b'workflow-isolation-fixture'); os.close(fd)"
    )])
    run([*COORDINATOR, "/usr/bin/git", "init", "--bare", "--quiet", "--template=", str(REVIEW_GIT)])
    run([*COORDINATOR, BROKER, "prepare-workspace"])
    workspace_info = CHECKOUT.stat()
    assert (workspace_info.st_uid, workspace_info.st_gid) == (10001, 1000)
    assert stat.S_IMODE(workspace_info.st_mode) == 0o2770
    # A setup script may make its checkout private. From here, every workload
    # below must enter it after changing to the workflow UID.
    _, make_private = workload_command("process", "/usr/bin/chmod", "0700", ".")
    run([*COORDINATOR, *make_private], cwd="/")
    cannot_enter = subprocess.run([*COORDINATOR, "/usr/bin/test", "-x", str(CHECKOUT)], timeout=10)
    assert cannot_enter.returncode == 1, "The checkout is still traversable by the coordinator"
    target = Path("/run") / ("workflow-isolation-envd-" + uuid.uuid4().hex)
    hosts = {"127.0.0.1", "::1", *run(["/bin/hostname", "-I"]).stdout.split()}
    # Keep a real coordinator-UID process with live credentials to probe. The
    # subprocess on the other side is spawned through the installed cgroup broker.
    with subprocess.Popen([*COORDINATOR, "/usr/bin/python3", "-c", (
        f"import os, sys; fd=os.open({str(RELAY_CREDENTIAL)!r}, os.O_RDONLY);"
        "print(os.getpid(), fd, flush=True); sys.stdin.buffer.read()"
    )], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={
        **os.environ, "LAUNCHPAD_PROOF_COORDINATOR_CREDENTIAL": FIXTURE_CREDENTIAL,
    }) as coordinator:
        try:
            pid, fd = wait_for_line(coordinator)
            assert Path(f"/proc/{pid}").stat().st_uid == 1000
            work_id = uuid.uuid4().hex
            options = dict(cwd="/", user=1000, group=1000, extra_groups=[], env={
                **os.environ,
                "T3CODE_HOME": "/home/user/.launchpad",
                "CODEX_HOME": "/home/user/.codex",
                "LAUNCHPAD_WORKFLOW_GUEST": "1",
            })
            try:
                result = run([WORKLOAD, "run-workflow", work_id, "process", str(CHECKOUT), "--",
                              "/usr/bin/python3", "-", pid, fd, work_id, str(target),
                              *sorted(hosts)], input=Path(__file__).read_text(), **options)
            except subprocess.CalledProcessError as error:
                raise RuntimeError(f"Workflow launch failed:\n{error.stderr}") from None
            assert result.stdout.strip() == "workflow-isolation-ok"
            assert not target.exists(), "envd ran an unauthenticated root command"
        finally:
            coordinator.stdin.close()
            coordinator.wait(timeout=10)
    prove_workload_signals()
    prove_setup_owner()
    prove_native_codex_peer()
    prove_private_checkpoint_reader()
    print(json.dumps({
        "workflowEnrollment": True,
        "workflowLauncher": True,
        "coordinatorCredentialsProtected": True,
        "coordinatorSignallingDenied": True,
        "reviewGitProtected": True,
        "privilegedControlDenied": True,
        "envdRootCommandDenied": True,
        "envdRootFileReadDenied": True,
        "workspaceWritable": True,
        "detachedWorkloadStopped": True,
        "unrelatedWorkloadPreserved": True,
        "setupOwnerVerified": True,
        "nativeCodexPeerVerified": True,
        "otherCodexPeersDenied": True,
        "privateCheckpointReaderVerified": True,
    }))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        proof()
    else:
        workload_probe(*sys.argv[1:])
