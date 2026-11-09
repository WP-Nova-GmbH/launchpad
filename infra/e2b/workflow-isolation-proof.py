"""Exercise the installed workflow enrollment and workload launcher in a disposable VM."""

import base64
from contextlib import suppress
import ctypes
import ctypes.util
import errno
import gzip
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
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
MAX_NATIVE_REQUEST_BYTES = 4 * 1024 * 1024


def decode_native_request(body, encoding):
    assert 0 < len(body) <= MAX_NATIVE_REQUEST_BYTES, "Native inference request exceeded its bound"
    if encoding == "identity":
        decoded = body
    elif encoding == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
            decoded = compressed.read(MAX_NATIVE_REQUEST_BYTES + 1)
    elif encoding == "zstd":
        library = "libzstd.so.1" if sys.platform.startswith("linux") else ctypes.util.find_library("zstd")
        assert library, "The system zstd decoder is unavailable"
        zstd = ctypes.CDLL(library)
        zstd.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
        zstd.ZSTD_decompress.restype = ctypes.c_size_t
        zstd.ZSTD_isError.argtypes = [ctypes.c_size_t]
        zstd.ZSTD_isError.restype = ctypes.c_uint
        # Codex sends zstd frames, including frames without a declared size.
        # A fixed destination bounds decompression before JSON parsing.
        destination = ctypes.create_string_buffer(MAX_NATIVE_REQUEST_BYTES)
        source = ctypes.create_string_buffer(body)
        size = zstd.ZSTD_decompress(destination, len(destination), source, len(body))
        assert not zstd.ZSTD_isError(size), "Invalid or oversized zstd native request"
        decoded = destination.raw[:size]
    else:
        raise AssertionError("Unsupported native request content encoding")
    assert len(decoded) <= MAX_NATIVE_REQUEST_BYTES, "Decoded native inference request exceeded its bound"
    return json.loads(decoded)


def workflow_sandbox_policy(policy):
    value = policy.get("workflowSandboxPolicy")
    assert value == {"type": "externalSandbox", "networkAccess": "enabled"}, \
        "Rebuild the guest with the workflow external sandbox policy"
    return value


def native_failure_summary(error):
    if isinstance(error, dict):
        kind = error.get("codexErrorInfo", error.get("code", "nativeError"))
        category = list(kind)[:3] if isinstance(kind, dict) else str(kind)[:100]
        message = str(error.get("message", ""))
    else:
        category, message = type(error).__name__, str(error)
    # Only bounded error summaries belong in proof evidence, never the request
    # body, headers or the local fixture's bearer permit.
    message = re.split(r"(?i)\b(?:request\s+(?:body|headers)|authorization)\b", message, maxsplit=1)[0]
    message = re.sub(r"(?i)Bearer\s+[^\s\"'<>]+", "Bearer [redacted]", message)
    return {"category": category, "message": message[:600]}


def native_request_tools(request):
    tools = list(request["tools"]) if isinstance(request.get("tools"), list) else []
    # Pinned Codex Responses Lite moves tool definitions into a developer
    # additional_tools input item and omits the top-level tools field.
    inputs = request.get("input")
    for item in inputs if isinstance(inputs, list) else []:
        if isinstance(item, dict) and item.get("type") == "additional_tools" \
                and item.get("role") == "developer" and isinstance(item.get("tools"), list):
            tools.extend(item["tools"])
    return tools


def native_tool_manifest(tools):
    """Diagnostic schema metadata only: never descriptions, defaults or input values."""
    if not isinstance(tools, list):
        return [{"type": "invalid tool list"}]
    manifest = []
    for tool in tools[:32]:
        if not isinstance(tool, dict):
            continue
        entry = {key: str(tool[key])[:80] for key in ("type", "name", "namespace") if key in tool}
        parameters = tool.get("parameters")
        if isinstance(parameters, dict):
            required = parameters.get("required", [])
            entry["required"] = [str(key)[:60] for key in required[:16]] if isinstance(required, list) else []
            properties = parameters.get("properties", {})
            if isinstance(properties, dict):
                entry["properties"] = {str(key)[:60]: str(value.get("type", "unspecified"))[:60]
                                       for key, value in list(properties.items())[:16] if isinstance(value, dict)}
        if isinstance(tool.get("tools"), list):
            entry["tools"] = native_tool_manifest(tool["tools"][:16])
        manifest.append(entry)
    return manifest


def native_request_metadata(request):
    if not isinstance(request, dict):
        return {"type": type(request).__name__}
    tools, inputs, choice = request.get("tools"), request.get("input"), request.get("tool_choice")
    metadata = {
        "keys": [str(key)[:60] for key in list(request)[:40]],
        "toolsType": type(tools).__name__,
        "toolsCount": len(tools) if isinstance(tools, list) else None,
        "nativeToolCount": len(native_request_tools(request)),
        "inputType": type(inputs).__name__,
        "inputCount": len(inputs) if isinstance(inputs, list) else None,
        "flags": {str(key)[:60]: value for key, value in list(request.items())[:60] if isinstance(value, bool)},
    }
    if isinstance(request.get("model"), str):
        metadata["model"] = request["model"][:100]
    if isinstance(choice, str):
        metadata["toolChoice"] = choice[:80]
    elif isinstance(choice, dict):
        metadata["toolChoice"] = {key: str(choice[key])[:80] for key in ("type", "name", "mode")
                                  if key in choice and isinstance(choice[key], (str, bool))}
    if isinstance(inputs, list):
        metadata["inputItems"] = [{key: str(item[key])[:60] for key in ("type", "role")
                                   if key in item and isinstance(item[key], str)}
                                  if isinstance(item, dict) else {"type": type(item).__name__}
                                  for item in inputs[:20]]
    return metadata


def native_tool_response(request, call_id, command, expected_output):
    """Use the native tool advertised by the pinned binary, never a planted MCP tool."""
    outputs = [item for item in request.get("input", [])
               if item.get("type") in {"function_call_output", "custom_tool_call_output"}
               and item.get("call_id") == call_id]
    if outputs:
        assert len(outputs) == 1, "Native command returned duplicate tool outputs"
        assert not any(item["type"] == "custom_tool_call_output" \
                       and "Script running with cell ID" in json.dumps(item["output"]) for item in outputs), \
            "The native CodeMode cell did not finish before yielding"
        if expected_output:
            assert expected_output in json.dumps(outputs[0]["output"]), \
                "The native tool did not return the executed command's output"
        item = {"type": "message", "id": "msg_" + call_id, "role": "assistant",
                "content": [{"type": "output_text", "text": "Native workflow probe finished."}]}
    else:
        candidates = []
        for tool in native_request_tools(request):
            if tool.get("type") == "namespace" and tool.get("name") == "functions":
                candidates.extend((child, "functions") for child in tool.get("tools", []))
            else:
                candidates.append((tool, None))
        native = next(((tool, namespace) for tool, namespace in candidates
                       if tool.get("type") == "function"
                       and tool.get("name") in {"exec_command", "shell_command"}), None)
        if native:
            tool, namespace = native
            fields = tool["parameters"]["properties"]
            key = "cmd" if tool["name"] == "exec_command" else "command"
            assert key in fields, "The pinned native command schema changed"
            args = {key: command}
            for name, value in (("yield_time_ms", 1000), ("timeout_ms", 10000), ("login", False)):
                if name in fields:
                    args[name] = value
            assert set(tool["parameters"].get("required", [])) <= args.keys(), \
                "The pinned native command tool needs unsupported arguments"
            item = {"type": "function_call", "call_id": call_id,
                    "name": tool["name"], "arguments": json.dumps(args)}
        else:
            code_mode = next(((tool, namespace) for tool, namespace in candidates
                              if tool.get("type") == "custom" and tool.get("name") == "exec"), None)
            assert code_mode, "The pinned Codex binary did not advertise a native command tool"
            tool, namespace = code_mode
            # Pinned CodeMode exposes native commands through tools.exec_command.
            # Keep both its real nested command and its approval/completion receipts.
            args = {"cmd": command, "yield_time_ms": 10000, "max_output_tokens": 1000, "login": False}
            code = '// @exec: {"yield_time_ms":30000,"max_output_tokens":1000}\n' \
                + "text(await tools.exec_command(" + json.dumps(args) + "));"
            item = {"type": "custom_tool_call", "call_id": call_id,
                    "name": tool["name"], "input": code}
        if namespace:
            item["namespace"] = namespace
    response_id = "resp_" + call_id + ("_final" if outputs else "_tool")
    events = [
        {"type": "response.created", "response": {"id": response_id}},
        {"type": "response.output_item.done", "item": item},
        {"type": "response.completed", "response": {"id": response_id,
            "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
    ]
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                   for event in events).encode(), bool(outputs)


class NativeCodexRpc:
    def __init__(self, process, deadline):
        self.process, self.deadline = process, deadline
        self.pending = b""
        self.notifications = []
        self.settings = {}

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        self.process.stdin.flush()

    def read(self):
        with selectors.DefaultSelector() as ready:
            ready.register(self.process.stdout, selectors.EVENT_READ)
            while b"\n" not in self.pending:
                remaining = self.deadline - time.monotonic()
                assert remaining > 0 and ready.select(remaining), "Pinned Codex execution proof timed out"
                chunk = os.read(self.process.stdout.fileno(), 65536)
                assert chunk, "Pinned Codex exited during the execution proof"
                self.pending += chunk
                assert len(self.pending) <= 4 * 1024 * 1024, "Pinned Codex RPC output exceeded its bound"
        line, self.pending = self.pending.split(b"\n", 1)
        return json.loads(line)

    def request(self, request_id, method, params):
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            message = self.read()
            if message.get("id") == request_id and "method" not in message:
                assert "result" in message, f"Pinned Codex {method} failed"
                return message["result"]
            self.notifications.append(message)

    def receive(self):
        return self.notifications.pop(0) if self.notifications else self.read()


def prepare_fixture_hook(rpc, command, allow_trust):
    def listed(request_id):
        response = rpc.request(request_id, "hooks/list", {"cwds": [str(CHECKOUT)]})
        hooks = [hook for entry in response["data"] if entry["cwd"] == str(CHECKOUT)
                 for hook in entry["hooks"]
                 if hook.get("eventName") == "sessionStart" and hook.get("handlerType") == "command"
                 and hook.get("command") == command and hook.get("source") == "user"
                 and hook.get("sourcePath") == "/home/launchpad-workflow/.codex/config.toml"]
        assert len(hooks) == 1, "The owned startup hook was not discovered in the workload user config"
        hook = hooks[0]
        assert hook["enabled"] and not hook["isManaged"] \
            and re.fullmatch(r"sha256:[0-9a-f]{64}", hook["currentHash"]), "The owned hook identity changed"
        return hook

    hook = listed(20)
    if allow_trust:
        assert hook["trustStatus"] == "untrusted", "The fresh fixture hook was unexpectedly already trusted"
        # This is the normal per-hook trust operation. Never bypass trust for
        # other user/project/plugin hooks discovered in the same home.
        rpc.request(21, "config/batchWrite", {
            "edits": [{"keyPath": "hooks.state", "mergeStrategy": "upsert",
                       "value": {hook["key"]: {"trusted_hash": hook["currentHash"]}}}],
            "reloadUserConfig": True,
        })
        current = listed(22)
        assert current["key"] == hook["key"] and current["currentHash"] == hook["currentHash"], \
            "The hook changed while recording fixture trust"
        hook = current
    assert hook["trustStatus"] == "trusted", "The fixture hook trust did not survive native startup"


def verify_native_turn(rpc, thread_id, turn_id, call_id, decision, output, policy, fixture_failures=()):
    approval_item = None
    completed = []
    settings = rpc.settings.get(thread_id)
    while True:
        message = rpc.receive()
        method, params = message.get("method"), message.get("params", {})
        if method == "thread/settings/updated" and params.get("threadId") == thread_id:
            settings = params["threadSettings"]
            rpc.settings[thread_id] = settings
        elif method == "item/commandExecution/requestApproval":
            assert params.get("threadId") == thread_id and params.get("turnId") == turn_id
            assert approval_item is None and call_id in params.get("command", "") \
                and "/usr/bin/python3" in params.get("command", ""), \
                "An unexpected native command requested approval"
            assert settings and settings.get("sandboxPolicy") == policy \
                and settings.get("approvalPolicy") == "untrusted" \
                and settings.get("approvalsReviewer") == "user", "Codex did not apply the workflow turn policy"
            approval_item = params["itemId"]
            rpc.send({"id": message["id"], "result": {"decision": decision}})
        elif "id" in message and method:
            raise AssertionError("An unexpected native server request interrupted the command proof")
        elif method == "item/completed" and params.get("threadId") == thread_id \
                and params.get("turnId") == turn_id:
            completed.append(params["item"])
        elif method == "turn/completed" and params.get("threadId") == thread_id \
                and params.get("turn", {}).get("id") == turn_id:
            assert params["turn"]["status"] == "completed", "The native command turn did not complete: " + json.dumps({
                "status": str(params["turn"]["status"])[:40],
                "error": native_failure_summary(params["turn"].get("error")),
                "fixtureFailures": fixture_failures[-3:],
            })
            assert approval_item is not None, "The native command bypassed approval"
            if decision == "accept":
                assert any(item.get("id") == approval_item and item.get("type") == "commandExecution"
                           and item.get("status") == "completed" and item.get("exitCode") == 0
                           and output in (item.get("aggregatedOutput") or "") for item in completed), \
                    "The approved native command did not finish with its expected output"
            return


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


def stop_native_fixture_group(process, group):
    # Exercise cold recovery after an abrupt, owned process-tree loss. Killing
    # before EOF keeps the captured parent identity alive at this boundary.
    assert process.poll() is None, "The native fixture parent exited before owned replacement"
    (group / "cgroup.kill").write_text("1")
    process.wait(timeout=10)
    wait_until_empty(group)


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
    permit, nonce = uuid.uuid4().hex, uuid.uuid4().hex
    recognized = threading.Event()
    rejected_plugin = threading.Event()
    provider = identity = work_id = None
    scenario = None
    failures = []
    tool_outputs = set()
    deadline = time.monotonic() + 60
    markers = {name: CHECKOUT / f".codex-proof-{nonce}-{name}" for name in ("denied", "approved", "resumed", "hooks")}
    commands = {}
    for name in ("denied", "approved", "resumed"):
        code = "\n".join([
            "import ctypes, errno, os",
            "from pathlib import Path",
            "assert os.getresuid() == (10001, 10001, 10001)",
            "assert os.getgroups() == []",
            "libc = ctypes.CDLL(None, use_errno=True)",
            "assert libc.prctl(4, 1, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM",
            f"Path({str(markers[name])!r}).write_text({(nonce + '-' + name)!r})",
            f"print({(nonce + '-' + name)!r}, flush=True)",
        ])
        commands[name] = "/usr/bin/python3 -c " + shlex.quote(code)

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
            stage = "request decoding"
            encoding = self.headers.get("Content-Encoding", "identity").lower().strip()
            request = None
            try:
                length = int(self.headers.get("Content-Length", "0"))
                assert 0 < length <= MAX_NATIVE_REQUEST_BYTES, "Native inference request exceeded its bound"
                body = self.rfile.read(length)
                request = decode_native_request(body, encoding)
                assert scenario in commands
                expected = None if scenario == "denied" else nonce + "-" + scenario
                stage = "native tool schema/output"
                response, finished = native_tool_response(
                    request, nonce + "-" + scenario, commands[scenario], expected,
                )
                if finished:
                    tool_outputs.add(scenario)
            except Exception as error:
                failures.append({"stage": stage,
                                 "encoding": encoding if encoding in {"identity", "gzip", "zstd"} else "unsupported",
                                 "requestMetadata": native_request_metadata(request),
                                 "advertisedTools": native_tool_manifest(native_request_tools(request)) if isinstance(request, dict) else [],
                                 **native_failure_summary(error)})
                self.send_error(500, "Native execution fixture rejected the request")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Inference) as proxy:
        origin = f"http://127.0.0.1:{proxy.server_port}/v1"
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        proxy_thread.start()
        try:
            model_policy = json.loads(run(["/opt/launchpad/server/t3", "__thread-vm-codex-model-policy"], **options).stdout)
            sandbox_policy = workflow_sandbox_policy(model_policy)
            app_args = [value.replace("http://127.0.0.1:1/v1", origin).replace(
                'command="/usr/bin/false",args=[]',
                'command="/usr/bin/printenv",args=["LAUNCHPAD_WORKFLOW_CODEX_PERMIT"]',
            ) for value in model_policy["probeArgs"]]
            # A previous step can plant a startup command in the shared home. It
            # still cannot borrow the native provider's inference permit.
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
            hook_code = "\n".join([
                "import json, os, sys",
                "data = json.load(sys.stdin)",
                f"with open({str(markers['hooks'])!r}, 'a') as output:",
                " output.write(json.dumps({'source': data['source'], 'sessionId': data['session_id'], 'uid': os.getuid()}) + '\\n')",
            ])
            hook = "/usr/bin/python3 -c " + shlex.quote(hook_code)
            _, plant = workload_command("process", "/usr/bin/python3", "-c", """
from pathlib import Path
import sys
Path.home().joinpath('.codex', 'config.toml').write_text(sys.stdin.read())
""")
            run(plant, input=(
                '[features]\nhooks = true\n'
                '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ntimeout = 5\n'
                + 'command = ' + json.dumps(hook) + '\n'
                + '[mcp_servers.planted]\ncommand = "/usr/bin/python3"\nstartup_timeout_sec = 5\n'
                + 'args = ' + json.dumps(["-c", plugin, origin, permit]) + '\n'
            ), **options)
            thread_id = None
            launched = []
            try:
                for episode in range(2):
                    work_id, command = workload_command("provider", CODEX, *app_args)
                    provider = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=subprocess.DEVNULL, start_new_session=True, **options, env={
                                                    "PATH": "/usr/bin:/bin", "LAUNCHPAD_WORKFLOW_CODEX_PERMIT": permit,
                                                })
                    launched.append((work_id, provider))
                    rpc = NativeCodexRpc(provider, deadline)
                    rpc.request(1, "initialize", {
                        "clientInfo": {"name": "launchpad_workflow_smoke", "version": "1"},
                        "capabilities": {"experimentalApi": True},
                    })
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
                    rpc.send({"method": "initialized"})
                    prepare_fixture_hook(rpc, hook, allow_trust=episode == 0)
                    params = {"cwd": str(CHECKOUT), "model": model_policy["defaultModel"],
                              "approvalPolicy": "untrusted", "approvalsReviewer": "user", "sandbox": "read-only"}
                    if thread_id:
                        params.update(threadId=thread_id, excludeTurns=True)
                        opened = rpc.request(2, "thread/resume", params)
                        assert opened["thread"]["id"] == thread_id, "Codex resumed another conversation"
                    else:
                        opened = rpc.request(2, "thread/start", params)
                        thread_id = opened["thread"]["id"]
                    for request_id, name in enumerate(("denied", "approved") if episode == 0 else ("resumed",), 3):
                        scenario = name
                        turn = rpc.request(request_id, "turn/start", {
                            "threadId": thread_id, "approvalPolicy": "untrusted", "approvalsReviewer": "user",
                            "sandboxPolicy": sandbox_policy,
                            "input": [{"type": "text", "text": "Run the fixed native workflow probe.", "text_elements": []}],
                        })["turn"]
                        verify_native_turn(rpc, thread_id, turn["id"], nonce + "-" + name,
                                           "decline" if name == "denied" else "accept", nonce + "-" + name,
                                           sandbox_policy, fixture_failures=failures)
                        assert not failures, "Native inference fixture failed: " + json.dumps(failures[-3:])
                        assert name in tool_outputs, "Codex did not return a real native tool result"
                        assert not markers["denied"].exists(), "The denied native command executed"
                        if name != "denied":
                            assert markers[name].read_text() == nonce + "-" + name
                    expected_hooks = ["startup"] if episode == 0 else ["startup", "resume"]
                    hooks = [json.loads(line) for line in markers["hooks"].read_text().splitlines()]
                    assert [entry["source"] for entry in hooks] == expected_hooks, "Startup/resume hook did not finish"
                    assert all(entry["sessionId"] == thread_id and entry["uid"] == 10001 for entry in hooks)
                    stop_native_fixture_group(provider, CGROUP_ROOT / work_id)
                    provider.stdin.close()
                    provider.stdout.close()
                assert recognized.is_set() and rejected_plugin.wait(5), "Native/other-peer proof was incomplete"
            finally:
                for owned_id, process in launched:
                    with suppress(OSError):
                        (CGROUP_ROOT / owned_id / "cgroup.kill").write_text("1")
                    if process.poll() is None:
                        process.wait(timeout=5)
                    if not process.stdin.closed:
                        process.stdin.close()
                    process.stdout.close()
                for path in markers.values():
                    path.unlink(missing_ok=True)
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
        "nativeCodexCommandExecuted": True,
        "nativeCodexApprovalDenied": True,
        "nativeCodexResumeExecuted": True,
        "nativeCodexDumpabilityProtected": True,
        "nativeCodexStartupHooksExecuted": True,
        "nativeCodexWorkloadsStopped": True,
        "privateCheckpointReaderVerified": True,
    }))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        proof()
    else:
        workload_probe(*sys.argv[1:])
