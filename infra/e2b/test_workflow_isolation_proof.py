import ast
import ctypes
import ctypes.util
import gzip
import importlib.util
import json
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "workflow_isolation_proof", Path(__file__).with_name("workflow-isolation-proof.py")
)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
POLICY = {"type": "externalSandbox", "networkAccess": "enabled"}


class FakeRpc:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.settings = {}
        self.sent = []

    def receive(self):
        return next(self.messages)

    def send(self, message):
        self.sent.append(message)


def turn_receipts():
    return [
        {"method": "thread/settings/updated", "params": {
            "threadId": "thread", "threadSettings": {
                "sandboxPolicy": POLICY, "approvalPolicy": "untrusted", "approvalsReviewer": "user",
            },
        }},
        {"id": 90, "method": "item/commandExecution/requestApproval", "params": {
            "threadId": "thread", "turnId": "turn", "itemId": "native-item",
            "command": "/usr/bin/python3 -c 'print(\"proof-call\")'",
        }},
        {"method": "item/completed", "params": {
            "threadId": "thread", "turnId": "turn", "item": {
                "id": "native-item", "type": "commandExecution", "status": "completed",
                "exitCode": 0, "aggregatedOutput": "native-output\n",
            },
        }},
        {"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "turn", "status": "completed"},
        }},
    ]


class NativeExecutionProofTests(unittest.TestCase):
    def test_cold_replacement_stops_only_owned_group_before_parent_or_pipe_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            group = Path(directory) / "owned"
            group.mkdir()
            unrelated = Path(directory) / "unrelated.kill"
            unrelated.write_text("untouched")
            parent = mock.Mock()
            parent.poll.return_value = None

            def terminated(*, timeout):
                self.assertEqual((group / "cgroup.kill").read_text(), "1")
                self.assertFalse(parent.stdin.close.called)
                parent.poll.return_value = -9
                return -9

            def empty(actual_group):
                self.assertEqual(actual_group, group)
                self.assertEqual(parent.poll(), -9)

            parent.wait.side_effect = terminated
            with mock.patch.object(proof, "wait_until_empty", side_effect=empty):
                proof.stop_native_fixture_group(parent, group)
            self.assertEqual(unrelated.read_text(), "untouched")
            (group / "cgroup.kill").unlink()
            with self.assertRaisesRegex(AssertionError, "parent exited"):
                proof.stop_native_fixture_group(parent, group)
            self.assertFalse((group / "cgroup.kill").exists())

    def test_fixture_hook_uses_normal_exact_hash_trust_and_requires_it_after_restart(self):
        command = "/usr/bin/python3 -c 'owned startup marker'"
        owned = {"eventName": "sessionStart", "handlerType": "command", "command": command,
                 "source": "user", "sourcePath": "/home/launchpad-workflow/.codex/config.toml",
                 "enabled": True, "isManaged": False, "currentHash": "sha256:" + "a" * 64,
                 "key": "file:/home/launchpad-workflow/.codex/config.toml:session_start:0:0",
                 "trustStatus": "untrusted"}

        class HookRpc:
            def __init__(self):
                self.owned = copy.deepcopy(owned)
                self.writes = []

            def request(self, request_id, method, params):
                if method == "hooks/list":
                    return {"data": [{"cwd": str(proof.CHECKOUT), "hooks": [
                        copy.deepcopy(self.owned), {**self.owned, "command": "unrelated hook", "key": "other"},
                    ]}]}
                self.writes.append((method, params))
                self.owned["trustStatus"] = "trusted"
                return {}

        rpc = HookRpc()
        proof.prepare_fixture_hook(rpc, command, allow_trust=True)
        self.assertEqual(rpc.writes, [("config/batchWrite", {
            "edits": [{"keyPath": "hooks.state", "mergeStrategy": "upsert", "value": {
                owned["key"]: {"trusted_hash": owned["currentHash"]},
            }}], "reloadUserConfig": True,
        })])
        proof.prepare_fixture_hook(rpc, command, allow_trust=False)
        self.assertEqual(len(rpc.writes), 1)
        rpc.owned["trustStatus"] = "untrusted"
        with self.assertRaisesRegex(AssertionError, "did not survive"):
            proof.prepare_fixture_hook(rpc, command, allow_trust=False)
        self.assertEqual(len(rpc.writes), 1)
        rpc.owned["sourcePath"] = "/unrelated/config.toml"
        with self.assertRaisesRegex(AssertionError, "not discovered"):
            proof.prepare_fixture_hook(rpc, command, allow_trust=True)

    def test_native_request_decoding_rejects_unknown_or_oversized_payloads(self):
        body = b'{"probe": true}'
        for encoding, encoded in (("identity", body), ("gzip", gzip.compress(body))):
            self.assertEqual(proof.decode_native_request(encoded, encoding), {"probe": True})
        with self.assertRaisesRegex(AssertionError, "Unsupported"):
            proof.decode_native_request(body, "br")
        with self.assertRaisesRegex(AssertionError, "exceeded its bound"):
            proof.decode_native_request(gzip.compress(b"x" * (proof.MAX_NATIVE_REQUEST_BYTES + 1)), "gzip")

    def test_pinned_zstd_requests_decode_with_real_system_library_and_reject_bad_frames(self):
        library = ctypes.util.find_library("zstd")
        if not library:
            self.skipTest("No system zstd library is installed on this test host")
        zstd = ctypes.CDLL(library)
        zstd.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
        zstd.ZSTD_compressBound.restype = ctypes.c_size_t
        zstd.ZSTD_compress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        zstd.ZSTD_compress.restype = ctypes.c_size_t
        zstd.ZSTD_isError.argtypes = [ctypes.c_size_t]
        zstd.ZSTD_isError.restype = ctypes.c_uint

        def compress(body):
            source = ctypes.create_string_buffer(body)
            destination = ctypes.create_string_buffer(zstd.ZSTD_compressBound(len(body)))
            size = zstd.ZSTD_compress(destination, len(destination), source, len(body), 1)
            self.assertFalse(zstd.ZSTD_isError(size))
            return destination.raw[:size]

        self.assertEqual(proof.decode_native_request(compress(b'{"native": true}'), "zstd"), {"native": True})
        for body in (b"invalid zstd frame", compress(b"x" * (proof.MAX_NATIVE_REQUEST_BYTES + 1))):
            with self.assertRaisesRegex(AssertionError, "Invalid or oversized zstd"):
                proof.decode_native_request(body, "zstd")

    def test_embedded_python_programs_compile_without_reindenting_them(self):
        tree = ast.parse(Path(proof.__file__).read_text())
        programs = [node for node in ast.walk(tree)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str)
                    and "\n" in node.value and node.value.lstrip().startswith(("import ", "from "))]
        self.assertGreaterEqual(len(programs), 7)
        for program in programs:
            with self.subTest(line=program.lineno):
                compile(program.value, f"{proof.__file__}:{program.lineno}", "exec")

    def test_approves_only_after_effective_policy_and_requires_real_completion(self):
        rpc = FakeRpc(turn_receipts())
        proof.verify_native_turn(rpc, "thread", "turn", "proof-call", "accept", "native-output", POLICY)
        self.assertEqual(rpc.sent, [{"id": 90, "result": {"decision": "accept"}}])
        # A final assistant/turn receipt or a successful Responses POST cannot
        # stand in for a completed native command with its own output.
        receipts = turn_receipts()
        del receipts[2]
        with self.assertRaisesRegex(AssertionError, "approved native command did not finish"):
            proof.verify_native_turn(FakeRpc(receipts), "thread", "turn", "proof-call", "accept", "native-output", POLICY)

    def test_decline_is_sent_to_the_actual_native_approval(self):
        receipts = turn_receipts()
        del receipts[2]
        rpc = FakeRpc(receipts)
        proof.verify_native_turn(rpc, "thread", "turn", "proof-call", "decline", "unused", POLICY)
        self.assertEqual(rpc.sent, [{"id": 90, "result": {"decision": "decline"}}])
        del receipts[1]
        with self.assertRaisesRegex(AssertionError, "bypassed approval"):
            proof.verify_native_turn(FakeRpc(receipts), "thread", "turn", "proof-call", "decline", "unused", POLICY)

    def test_failed_turn_reports_native_and_fixture_causes_without_request_credentials(self):
        receipts = turn_receipts()
        receipts[-1]["params"]["turn"].update(status="failed", error={
            "codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 500}},
            "message": "stream rejected; Authorization: Bearer private-fixture-permit; request body omitted",
        })
        failures = [{"stage": "request decoding", "encoding": "zstd",
                     **proof.native_failure_summary(UnicodeError("Cannot decode compressed bytes"))}]
        with self.assertRaises(AssertionError) as caught:
            proof.verify_native_turn(FakeRpc(receipts), "thread", "turn", "proof-call", "decline", "unused", POLICY,
                                     fixture_failures=failures)
        detail = str(caught.exception)
        for expected in ('"status": "failed"', "httpConnectionFailed", "stream rejected", "request decoding", "zstd", "UnicodeError"):
            self.assertIn(expected, detail)
        self.assertNotIn("private-fixture-permit", detail)
        self.assertNotIn("Authorization", detail)
        self.assertNotIn("request body", detail)

    def test_rejects_failed_or_wrong_command_results(self):
        for change in ({"exitCode": 1}, {"status": "failed"}, {"id": "another-item"},
                       {"aggregatedOutput": "another command"}, {"type": "agentMessage"}):
            with self.subTest(change=change):
                receipts = turn_receipts()
                receipts[2]["params"]["item"].update(change)
                with self.assertRaisesRegex(AssertionError, "approved native command did not finish"):
                    proof.verify_native_turn(FakeRpc(receipts), "thread", "turn", "proof-call", "accept", "native-output", POLICY)

    def test_never_answers_approval_under_a_changed_policy_or_identity(self):
        for change in ({"sandboxPolicy": {"type": "readOnly"}}, {"approvalPolicy": "never"},
                       {"approvalsReviewer": "auto_review"}):
            receipts = turn_receipts()
            receipts[0]["params"]["threadSettings"].update(change)
            rpc = FakeRpc(receipts)
            with self.assertRaisesRegex(AssertionError, "did not apply"):
                proof.verify_native_turn(rpc, "thread", "turn", "proof-call", "accept", "native-output", POLICY)
            self.assertEqual(rpc.sent, [])
        for change in ({"threadId": "another-thread"}, {"turnId": "another-turn"},
                       {"command": "/usr/bin/python3 -c 'unrelated'"}):
            receipts = turn_receipts()
            receipts[1]["params"].update(change)
            rpc = FakeRpc(receipts)
            with self.assertRaises(AssertionError):
                proof.verify_native_turn(rpc, "thread", "turn", "proof-call", "accept", "native-output", POLICY)
            self.assertEqual(rpc.sent, [])

    def test_native_tool_uses_advertised_schema_and_accepts_no_mcp_substitute(self):
        native = {"type": "function", "name": "exec_command", "parameters": {
            "properties": {"cmd": {}, "yield_time_ms": {}, "login": {}}, "required": ["cmd"],
        }}
        request = {"tools": [{"type": "namespace", "name": "functions", "tools": [native]}]}
        response, finished = proof.native_tool_response(request, "call", "native-command", "output")
        events = [json.loads(line[6:]) for line in response.decode().splitlines() if line.startswith("data: ")]
        item = events[1]["item"]
        self.assertFalse(finished)
        self.assertEqual((item["name"], item["namespace"]), ("exec_command", "functions"))
        self.assertEqual(json.loads(item["arguments"]), {"cmd": "native-command", "yield_time_ms": 1000, "login": False})
        request["tools"][0]["name"] = "mcp__planted"
        with self.assertRaisesRegex(AssertionError, "did not advertise"):
            proof.native_tool_response(request, "call", "native-command", "output")

    def test_responses_lite_uses_developer_additional_tools_without_top_level_tools(self):
        native = {"type": "function", "name": "exec_command", "parameters": {
            "properties": {"cmd": {}}, "required": ["cmd"],
        }}
        request = {"input": [{"type": "additional_tools", "role": "developer", "tools": [native]},
                             {"type": "message", "role": "user", "content": "private prompt"}]}
        response, finished = proof.native_tool_response(request, "lite-call", "native-command", "output")
        events = [json.loads(line[6:]) for line in response.decode().splitlines() if line.startswith("data: ")]
        self.assertFalse(finished)
        self.assertEqual(events[1]["item"]["name"], "exec_command")
        self.assertEqual(json.loads(events[1]["item"]["arguments"]), {"cmd": "native-command"})
        self.assertEqual(proof.native_tool_manifest(proof.native_request_tools(request))[0]["name"], "exec_command")
        self.assertEqual(proof.native_request_metadata(request)["nativeToolCount"], 1)
        request["input"][0]["role"] = "user"
        with self.assertRaisesRegex(AssertionError, "did not advertise"):
            proof.native_tool_response(request, "lite-call", "native-command", "output")

    def test_advertised_code_mode_calls_real_nested_command_and_requires_its_output(self):
        request = {"input": [{"type": "additional_tools", "role": "developer", "tools": [
            {"type": "namespace", "name": "functions", "tools": [{"type": "custom", "name": "exec"}]},
        ]}]}
        response, finished = proof.native_tool_response(request, "code-call", "native-command", "native-output")
        events = [json.loads(line[6:]) for line in response.decode().splitlines() if line.startswith("data: ")]
        call = events[1]["item"]
        self.assertFalse(finished)
        self.assertEqual((call["type"], call["namespace"], call["name"]), ("custom_tool_call", "functions", "exec"))
        self.assertIn("text(await tools.exec_command(", call["input"])
        self.assertIn('"cmd": "native-command"', call["input"])
        request["input"].append({"type": "custom_tool_call_output", "call_id": "code-call",
                                 "output": "native-output"})
        _, finished = proof.native_tool_response(request, "code-call", "native-command", "native-output")
        self.assertTrue(finished)
        request["input"][-1]["output"] = "Script running with cell ID still-running"
        for expected in ("native-output", None):
            with self.assertRaisesRegex(AssertionError, "did not finish"):
                proof.native_tool_response(request, "code-call", "native-command", expected)

    def test_tool_manifest_reports_only_bounded_schema_metadata(self):
        tools = [{"type": "function", "name": "shell", "description": "private description", "parameters": {
            "required": ["command"], "properties": {"command": {"type": "array", "default": "private value"}},
        }}]
        manifest = proof.native_tool_manifest(tools)
        self.assertEqual(manifest, [{"type": "function", "name": "shell", "required": ["command"],
                                     "properties": {"command": "array"}}])
        self.assertNotIn("private", json.dumps(manifest))
        self.assertEqual(len(proof.native_tool_manifest(tools * 100)), 32)

    def test_request_metadata_excludes_prompt_instructions_and_headers(self):
        request = {"model": "pinned-model", "tools": [], "generate": False, "stream": True,
                   "tool_choice": {"type": "function", "name": "exec_command", "description": "private"},
                   "input": [{"type": "message", "role": "user", "content": "private prompt"}],
                   "instructions": "private instructions", "headers": {"Authorization": "private bearer"}}
        metadata = proof.native_request_metadata(request)
        self.assertEqual(metadata["toolsCount"], 0)
        self.assertEqual(metadata["toolsType"], "list")
        self.assertEqual(metadata["flags"], {"generate": False, "stream": True})
        self.assertEqual(metadata["inputItems"], [{"type": "message", "role": "user"}])
        self.assertEqual(metadata["toolChoice"], {"type": "function", "name": "exec_command"})
        self.assertNotIn("private", json.dumps(metadata))

    def test_only_real_tool_output_finishes_the_inference_fixture(self):
        request = {"input": [{"type": "function_call_output", "call_id": "call", "output": "output"}]}
        _, finished = proof.native_tool_response(request, "call", "native-command", "output")
        self.assertTrue(finished)
        request["input"][0]["output"] = "tool failed before running"
        with self.assertRaisesRegex(AssertionError, "did not return"):
            proof.native_tool_response(request, "call", "native-command", "output")

    def test_old_or_weaker_packaged_policy_cannot_pass_execution_proof(self):
        self.assertEqual(proof.workflow_sandbox_policy({"workflowSandboxPolicy": POLICY}), POLICY)
        for policy in ({}, {"workflowSandboxPolicy": {"type": "dangerFullAccess"}},
                       {"workflowSandboxPolicy": {"type": "externalSandbox", "networkAccess": "restricted"}}):
            with self.assertRaisesRegex(AssertionError, "Rebuild"):
                proof.workflow_sandbox_policy(policy)

    def test_rpc_preserves_approval_that_arrives_before_turn_start_reply(self):
        script = """
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({'id': 90, 'method': 'item/commandExecution/requestApproval', 'params': {}}), flush=True)
print(json.dumps({'id': request['id'], 'result': {'turn': {'id': 'native-turn'}}}), flush=True)
"""
        with subprocess.Popen([sys.executable, "-u", "-c", script], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            rpc = proof.NativeCodexRpc(process, time.monotonic() + 5)
            self.assertEqual(rpc.request(1, "turn/start", {}), {"turn": {"id": "native-turn"}})
            self.assertEqual(rpc.receive()["id"], 90)
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
