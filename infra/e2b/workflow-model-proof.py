"""Read the pinned Codex model list without a user config or credentials."""

import json
import os
import selectors
import subprocess
import sys
import tempfile
import time


class ModelPolicyUnavailable(RuntimeError):
    pass


def isolated_environment(home):
    return {"HOME": home, "CODEX_HOME": home, "PATH": "/usr/bin:/bin"}


def read_policy(binary):
    with tempfile.TemporaryDirectory(prefix="launchpad-workflow-policy-") as home:
        result = subprocess.run(
            [binary, "__thread-vm-codex-model-policy"],
            cwd=home,
            env=isolated_environment(home),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )
    if result.returncode != 0:
        raise ModelPolicyUnavailable("Rebuild the selected VM runner to publish its Codex model catalog.")
    policy = json.loads(result.stdout)
    if (
        not isinstance(policy, dict)
        or policy.get("schemaVersion") != 1
        or not isinstance(policy.get("defaultModel"), str)
        or not isinstance(policy.get("modelSlugs"), list)
        or not all(isinstance(slug, str) for slug in policy["modelSlugs"])
        or policy["defaultModel"] not in policy["modelSlugs"]
        or not isinstance(policy.get("probeArgs"), list)
        or not policy["probeArgs"]
        or policy["probeArgs"][0] != "app-server"
        or not all(isinstance(arg, str) for arg in policy["probeArgs"])
    ):
        raise RuntimeError("The packaged VM server returned an invalid Codex model policy")
    return policy


def probe(binary, args):
    with tempfile.TemporaryDirectory(prefix="launchpad-workflow-models-") as home:
        process = subprocess.Popen(
            [binary, *args],
            cwd=home,
            env=isolated_environment(home),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                pending = b""
                deadline = time.monotonic() + 30

                def send(message):
                    process.stdin.write(json.dumps(message).encode() + b"\n")
                    process.stdin.flush()

                def request(request_id, method, params):
                    nonlocal pending
                    send({"id": request_id, "method": method, "params": params})
                    while True:
                        if b"\n" in pending:
                            line, pending = pending.split(b"\n", 1)
                            message = json.loads(line)
                            if message.get("id") == request_id:
                                if "result" not in message:
                                    raise RuntimeError(f"Codex {method} failed")
                                return message["result"]
                            continue
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise TimeoutError("Codex model probe timed out")
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            raise RuntimeError("Codex exited during the model probe")
                        pending += chunk
                        if len(pending) > 1024 * 1024:
                            raise RuntimeError("Codex model probe returned an oversized response")

                request(1, "initialize", {
                    "clientInfo": {"name": "launchpad_runner_smoke", "version": "1"},
                    "capabilities": {"experimentalApi": True},
                })
                send({"method": "initialized"})
                models = []
                cursor = None
                seen_cursors = set()
                request_id = 2
                while True:
                    result = request(request_id, "model/list", {"cursor": cursor} if cursor else {})
                    models.extend(
                        {"slug": model["model"], "name": model["displayName"]}
                        for model in result["data"]
                    )
                    if len(models) > 128:
                        raise RuntimeError("Codex model probe returned too many models")
                    cursor = result.get("nextCursor")
                    if not cursor:
                        return models
                    if cursor in seen_cursors:
                        raise RuntimeError("Codex returned a repeated model cursor")
                    seen_cursors.add(cursor)
                    request_id += 1
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def guest_catalog(server_binary, codex_binary):
    policy = read_policy(server_binary)
    allowed = set(policy["modelSlugs"])
    models = [
        model for model in probe(codex_binary, policy["probeArgs"])
        if model["slug"] in allowed
    ]
    if not any(model["slug"] == policy["defaultModel"] for model in models):
        raise RuntimeError("Codex did not report the packaged VM server's default model")
    return {"defaultModel": policy["defaultModel"], "models": models}


if __name__ == "__main__":
    try:
        print(json.dumps(guest_catalog(
            "/opt/launchpad/server/t3",
            "/opt/launchpad/node/bin/codex",
        )))
    except ModelPolicyUnavailable as error:
        print("launchpad-workflow-model-policy-unavailable", file=sys.stderr)
        print(str(error), file=sys.stderr)
        sys.exit(1)
