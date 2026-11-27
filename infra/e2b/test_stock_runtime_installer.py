"""Isolated Linux shell contracts; optionally exercise the exact pinned fetch script.

Set STOCK_RUNTIME_TEST_FETCH_SCRIPT to the pinned source checkout's
embed/compose/scripts/fetch-artifacts.sh to run its integration checks too.
All host paths and external I/O are redirected into a private temporary directory.
"""

import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("stock_installer_builder", Path(__file__).with_name("build-stock-runtime.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

PINNED_FETCH_SHA256 = "be6da2e212b3e2792e6f673b79df8249a3e25071e719ebc73ae40fe790b6261b"

# A controlled network boundary for the core installer contracts. The opt-in
# integration class below runs the unmodified, checksum-bound upstream helper.
FETCH_FIXTURE = r'''#!/usr/bin/env bash
HOST_ROOT="${HOST_ROOT:-/host}"
BUCKET="${BUCKET:-https://fixture.invalid}"
FA_ARCH="${FA_ARCH:-$(uname -m)}"
goarch() {
  case "$1" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; *) return 1;; esac
}
fetch() {
  local key="$1" dest="$2" mode="$3" want got
  want=$(curl -fsSL "$BUCKET/$key.sha256") || return 1
  want="${want%%[[:space:]]*}"
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | awk '{print $1}')" = "$want" ]; then
    chmod "$mode" "$dest"; return
  fi
  mkdir -p "$(dirname "$dest")"
  curl -fsSL -o "$dest.tmp" "$BUCKET/$key" || { rm -f "$dest.tmp"; return 1; }
  got=$(sha256sum "$dest.tmp" | awk '{print $1}')
  [ "$got" = "$want" ] || { rm -f "$dest.tmp"; return 1; }
  mv "$dest.tmp" "$dest"
  chmod "$mode" "$dest"
}
if [ -z "${FA_NO_MAIN:-}" ]; then echo 'upstream main must never run' >&2; exit 91; fi
'''


IO_DRIVER = r'''import fcntl, hashlib, json, os, pathlib, subprocess, sys
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["STOCK_TEST_EVENTS"], "a") as events:
    events.write(json.dumps([command, args]) + "\n")
match = os.environ.get("STOCK_TEST_BLOCK_MATCH", "")
if command == os.environ.get("STOCK_TEST_BLOCK_COMMAND") and any(match in arg for arg in args):
    if command == "curl" and "-o" in args:
        pathlib.Path(args[args.index("-o") + 1]).write_bytes(b"interrupted partial download")
    with open(os.environ["STOCK_TEST_READY"], "w") as ready:
        ready.write(str(os.getpid()) + "\n")
    with open(os.environ["STOCK_TEST_RELEASE"]) as release:
        release.read(1)
failure = os.environ.get("STOCK_TEST_FAIL_MATCH", "")
matches = failure in args if os.environ.get("STOCK_TEST_FAIL_EXACT") else any(failure in arg for arg in args)
if command == os.environ.get("STOCK_TEST_FAIL_COMMAND") and matches:
    sys.exit(72)
if command == "curl":
    key = args[-1].split("/", 3)[-1]
    payload = ("dependency:" + key.removesuffix(".sha256")).encode()
    if "-o" not in args:
        print(hashlib.sha256(payload).hexdigest() + "  artifact")
    else:
        output = pathlib.Path(args[args.index("-o") + 1])
        if os.environ.get("STOCK_TEST_BAD_CHECKSUM") in (key, "all"):
            payload = b"bad download"
        output.write_bytes(payload)
        if os.environ.get("STOCK_TEST_BAD_DOWNLOAD") in (key, "all"):
            sys.exit(22)
    sys.exit(0)
if command == "fixture-setup":
    owner = pathlib.Path(os.environ["HOST_ROOT"]) / "var/lib/e2b/launchpad-stock-runtime-owner"
    assert owner.read_text().strip() == os.environ["STOCK_RUNTIME_OWNER"]
    with open(os.environ["STOCK_TEST_LOCK"], "a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise AssertionError("host setup was entered without the host lock")
    pathlib.Path(os.environ["STOCK_TEST_SETUP_RESULT"]).write_text("configured")
    sys.exit(0)
if command == "nsenter":
    os.execv(os.environ["STOCK_TEST_BASH"], [os.environ["STOCK_TEST_BASH"], "-s"])
tools = json.loads(os.environ["STOCK_TEST_TOOLS"])
if command == "install" and os.environ.get("STOCK_TEST_CORRUPT_COPY") and pathlib.Path(args[-1]).name == ".stock-runtime-orchestrator.pending":
    subprocess.run([tools[command], *args], check=True)
    pathlib.Path(args[-1]).write_bytes(b"corrupted during copy")
    sys.exit(0)
os.execv(tools[command], [tools[command], *args])
'''


def linux_shell_available():
    if sys.platform != "linux" or os.geteuid() != 0:
        return False
    required = ("bash", "flock", "sha256sum", "sync", "install", "mv", "ln", "stat")
    if not all(shutil.which(tool) for tool in required):
        return False
    return subprocess.run(["bash", "-c", '(( BASH_VERSINFO[0] >= 4 ))'], capture_output=True).returncode == 0


@unittest.skipUnless(linux_shell_available(), "installer contracts require Linux root, Bash 4+, flock and GNU tools")
class StockRuntimeInstallerTests(unittest.TestCase):
    fetch_source = FETCH_FIXTURE

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="stock-installer-test-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.host = self.root / "host"
        self.state = self.host / "var/lib/e2b"
        self.binary = self.state / "bin/orchestrator"
        self.owner = self.state / "launchpad-stock-runtime-owner"
        self.lock = self.host / "run/lock/launchpad-e2b-snapshot-collector.lock"
        for directory in [self.binary.parent, self.lock.parent, self.state / "storage/templates", self.state / "storage/build-cache", self.root / "proc", self.root / "tools", self.root / "scripts"]:
            directory.mkdir(parents=True, exist_ok=True)
        self.source = self.root / "orchestrator"
        self.source.write_bytes(b"verified source-built orchestrator")
        self.events = self.root / "events.jsonl"
        self.events.touch()
        self.setup_result = self.root / "setup-result"
        self.bash = shutil.which("bash")
        tools = {name: shutil.which(name) for name in ["flock", "sync", "install", "mv", "ln"]}
        for command in [*tools, "curl", "nsenter", "fixture-setup"]:
            path = self.root / "tools" / command
            path.write_text("#!" + sys.executable + "\n" + IO_DRIVER)
            path.chmod(0o755)
        scripts = self.root / "scripts"
        (scripts / "fetch-artifacts.sh").write_text(self.fetch_source)
        (scripts / "host-setup.sh").write_text("fixture-setup host-setup\n")
        (scripts / "preflight.sh").write_text("echo fixture-preflight\n")
        self.script = self.root / "installer.sh"
        self.script.write_text(builder.INSTALLER.replace("/stock/orchestrator", str(self.source))
                               .replace("/opt/e2b/scripts", str(scripts))
                               .replace("/proc/[0-9]*/comm", str(self.root / "proc/[0-9]*/comm"))
                               .replace("/sys/fs/cgroup/e2b", str(self.root / "cgroup")))
        self.environment = {
            **os.environ, "PATH": str(self.root / "tools") + os.pathsep + os.environ["PATH"],
            "HOST_ROOT": str(self.host), "STOCK_RUNTIME_OWNER": "fixture-project:source:digest",
            "STOCK_ORCHESTRATOR_SHA256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "E2B_ENVD_VERSION": "test-envd", "E2B_FIRECRACKER_VERSION": "test-fc",
            "E2B_KERNEL_VERSION": "test-kernel", "E2B_BUSYBOX_VERSION": "test-busybox",
            "BUCKET": "https://fixture.invalid", "FA_ARCH": "aarch64",
            "STOCK_TEST_BASH": self.bash, "STOCK_TEST_EVENTS": str(self.events),
            "STOCK_TEST_TOOLS": json.dumps(tools), "STOCK_TEST_LOCK": str(self.lock),
            "STOCK_TEST_SETUP_RESULT": str(self.setup_result),
        }

    def run_installer(self, action="install", **environment):
        return subprocess.run([self.bash, str(self.script), action], env={**self.environment, **environment},
                              capture_output=True, text=True, timeout=15)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def calls(self, command):
        return [args for name, args in map(json.loads, self.events.read_text().splitlines()) if name == command]

    def seed_owned_binary(self):
        self.owner.write_text(self.environment["STOCK_RUNTIME_OWNER"] + "\n")
        self.owner.chmod(0o600)
        self.binary.write_bytes(b"previous source-built orchestrator")
        return self.binary.read_bytes()

    def barrier(self, command, match):
        ready, release = self.root / "ready", self.root / "release"
        os.mkfifo(ready)
        os.mkfifo(release)
        ready_fd = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
        release_fd = os.open(release, os.O_RDWR | os.O_NONBLOCK)
        self.addCleanup(os.close, ready_fd)
        def unblock_children():
            os.write(release_fd, b"x")
            os.close(release_fd)
            subprocess.run([shutil.which("flock"), "-x", str(self.lock), "true"], check=True, timeout=10)
        self.addCleanup(unblock_children)
        return {"STOCK_TEST_BLOCK_COMMAND": command, "STOCK_TEST_BLOCK_MATCH": match,
                "STOCK_TEST_READY": str(ready), "STOCK_TEST_RELEASE": str(release)}, ready_fd, release_fd

    def start(self, action, environment):
        output = (self.root / "background-output").open("w+")
        self.addCleanup(output.close)
        process = subprocess.Popen([self.bash, str(self.script), action],
                                   env={**self.environment, **environment}, stdout=output, stderr=output)
        def stop():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        self.addCleanup(stop)
        return process

    def await_barrier(self, fd):
        with selectors.DefaultSelector() as selector:
            selector.register(fd, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=10), "installer never reached its explicit barrier")
        return int(os.read(fd, 100).strip())

    def release(self, fd):
        os.write(fd, b"x")

    def test_setup_claims_before_host_writes_and_preflight_is_read_only(self):
        self.assert_success(self.run_installer("preflight"))
        self.assertFalse(self.owner.exists())
        self.assertFalse(self.lock.exists())
        self.assertFalse(self.setup_result.exists())
        self.assert_success(self.run_installer("setup"))
        self.assertTrue(self.setup_result.exists())
        self.assertEqual(self.owner.read_text().strip(), self.environment["STOCK_RUNTIME_OWNER"])
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.lock.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.lock.stat().st_uid, os.geteuid())
        self.assertEqual(self.lock.stat().st_nlink, 1)
        events = list(map(json.loads, self.events.read_text().splitlines()))
        link = next(index for index, (name, _) in enumerate(events) if name == "ln")
        setup = next(index for index, (name, _) in enumerate(events) if name == "fixture-setup")
        self.assertTrue(any(name == "sync" and args[-1].endswith(".pending") for name, args in events[:link]))
        self.assertTrue(any(name == "sync" and args[-1] == str(self.state) for name, args in events[link + 1:setup]))

    def test_setup_checks_versions_architecture_and_source_before_claim(self):
        for invalid in [{"E2B_ENVD_VERSION": "../other"}, {"E2B_KERNEL_VERSION": ""},
                        {"FA_ARCH": "unsupported"}, {"STOCK_ORCHESTRATOR_SHA256": "0" * 64}]:
            with self.subTest(invalid=invalid):
                result = self.run_installer("setup", **invalid)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.owner.exists())
                self.assertFalse(self.setup_result.exists())

    def test_setup_rejects_existing_state_and_active_execution_before_claim(self):
        cases = {"foreign-owner": "belongs to another deployment", "binary": "requires a separate migration",
                 "storage": "requires a separate migration", "active-process": "native E2B execution is active",
                 "active-cgroup": "native E2B cgroups are populated"}
        for case, reason in cases.items():
            with self.subTest(case=case), tempfile.TemporaryDirectory() as scratch:
                host = Path(scratch)
                state = host / "var/lib/e2b"
                (state / "bin").mkdir(parents=True)
                (host / "run/lock").mkdir(parents=True)
                if case == "foreign-owner":
                    (state / self.owner.name).write_text("somebody-else\n")
                    (state / self.owner.name).chmod(0o600)
                elif case == "binary":
                    (state / "bin/orchestrator").write_text("existing")
                elif case == "storage":
                    (state / "storage/templates").mkdir(parents=True)
                    (state / "storage/templates/snapshot").write_text("retained")
                elif case == "active-process":
                    (self.root / "proc/123").mkdir()
                    (self.root / "proc/123/comm").write_text("orchestrator\n")
                else:
                    (self.root / "cgroup").mkdir()
                    (self.root / "cgroup/cgroup.events").write_text("populated 1\n")
                result = self.run_installer("setup", HOST_ROOT=str(host))
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(reason, result.stderr)
                self.assertFalse(self.setup_result.exists())
                if case != "foreign-owner":
                    self.assertFalse((state / self.owner.name).exists())
                shutil.rmtree(self.root / "proc/123", ignore_errors=True)
                shutil.rmtree(self.root / "cgroup", ignore_errors=True)

    def test_four_native_keys_for_both_architectures_and_source_binary_last(self):
        for arch, ga, segment in [("x86_64", "amd64", ""), ("aarch64", "arm64", "arm64/")]:
            with self.subTest(arch=arch):
                self.events.write_text("")
                self.assert_success(self.run_installer(FA_ARCH=arch))
                downloads = [args[-1].removeprefix("https://fixture.invalid/") for args in self.calls("curl") if "-o" in args]
                expected = [f"envd/test-envd/{segment}envd", f"firecrackers/test-fc/{ga}/firecracker",
                            f"kernels/test-kernel/{ga}/vmlinux.bin", f"busybox/test-busybox/{ga}/busybox"]
                self.assertEqual(set(downloads), set(expected))
                requested = {args[-1].removeprefix("https://fixture.invalid/").removesuffix(".sha256") for args in self.calls("curl")}
                self.assertEqual(requested, set(expected))
                self.assertEqual(self.binary.read_bytes(), self.source.read_bytes())
                self.assertEqual(self.binary.stat().st_mode & 0o777, 0o755)
                for path, mode in [("fc-envd/envd", 0o755),
                                   (f"fc-versions/test-fc/{ga}/firecracker", 0o755),
                                   (f"fc-kernels/test-kernel/{ga}/vmlinux.bin", 0o644),
                                   (f"fc-busybox/test-busybox/{ga}/busybox", 0o755)]:
                    self.assertEqual((self.host / path).stat().st_mode & 0o777, mode)

    def test_failed_download_or_checksum_preserves_source_and_retry_is_bounded(self):
        old = self.seed_owned_binary()
        for failure in ["STOCK_TEST_BAD_DOWNLOAD", "STOCK_TEST_BAD_CHECKSUM"]:
            with self.subTest(failure=failure):
                result = self.run_installer(**{failure: "kernels/test-kernel/arm64/vmlinux.bin"})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.binary.read_bytes(), old)
                self.assertEqual(self.owner.read_text().strip(), self.environment["STOCK_RUNTIME_OWNER"])
        unrelated = self.state / ".stock-runtime-owner-unrelated.pending"
        unrelated.write_text("keep")
        self.assert_success(self.run_installer())
        self.assertEqual(self.binary.read_bytes(), self.source.read_bytes())
        self.assertEqual(unrelated.read_text(), "keep")
        self.assertFalse(list(self.host.rglob("*.tmp")))
        self.assertEqual(list(self.host.rglob("*.pending")), [unrelated])

    def test_source_copy_rename_and_sync_failures_observe_publication_boundary(self):
        for command, match, published in [("install", str(self.source), False),
                                          ("mv", ".stock-runtime-orchestrator.pending", False),
                                          ("sync", ".stock-runtime-orchestrator.pending", False),
                                          ("sync", str(self.binary.parent), True)]:
            with self.subTest(command=command, match=match):
                old = self.seed_owned_binary()
                result = self.run_installer(STOCK_TEST_FAIL_COMMAND=command, STOCK_TEST_FAIL_MATCH=match,
                                            STOCK_TEST_FAIL_EXACT="1" if match == str(self.binary.parent) else "")
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.binary.read_bytes(), self.source.read_bytes() if published else old)
                self.assert_success(self.run_installer())
        old = self.seed_owned_binary()
        self.assertNotEqual(self.run_installer(STOCK_TEST_CORRUPT_COPY="1").returncode, 0)
        self.assertEqual(self.binary.read_bytes(), old)
        self.assert_success(self.run_installer())

    def test_collector_lock_interoperates_and_is_never_unlinked(self):
        self.lock.touch(mode=0o600)
        inode = self.lock.stat().st_ino
        with self.lock.open("r+") as collector:
            fcntl.flock(collector, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_installer("setup")
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.owner.exists())
        environment, ready, release = self.barrier("fixture-setup", "host-setup")
        process = self.start("setup", environment)
        self.await_barrier(ready)
        with self.lock.open("r+") as collector:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(collector, fcntl.LOCK_EX | fcntl.LOCK_NB)
        foreign = self.run_installer("setup", STOCK_RUNTIME_OWNER="other-project:source:digest")
        self.assertNotEqual(foreign.returncode, 0)
        self.release(release)
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertNotEqual(self.run_installer("setup", STOCK_RUNTIME_OWNER="other-project:source:digest").returncode, 0)
        self.assertEqual(self.lock.stat().st_ino, inode)
        self.assertEqual(self.lock.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.lock.stat().st_uid, 0)
        self.assertEqual(self.lock.stat().st_nlink, 1)

    def test_interrupted_owner_publication_recovers_only_its_known_alias(self):
        key = hashlib.sha256(self.environment["STOCK_RUNTIME_OWNER"].encode()).hexdigest()
        pending = self.state / f".stock-runtime-owner-{key}.pending"
        environment, ready, release = self.barrier("ln", str(self.owner))
        process = self.start("setup", environment)
        self.await_barrier(ready)
        self.assertTrue(pending.is_file())
        self.assertFalse(self.owner.exists())
        process.kill()
        process.wait(timeout=10)
        self.release(release)
        subprocess.run([shutil.which("flock"), "-x", str(self.lock), "true"], check=True, timeout=10)
        self.assertEqual(self.owner.stat().st_ino, pending.stat().st_ino)
        self.assertEqual(self.owner.stat().st_nlink, 2)
        self.assert_success(self.run_installer("setup"))
        self.assertFalse(pending.exists())
        self.assertEqual(self.owner.stat().st_nlink, 1)

    def test_download_child_retains_lock_after_wrapper_is_killed_then_retry_cleans(self):
        old = self.seed_owned_binary()
        environment, ready, release = self.barrier("curl", "kernels/test-kernel/arm64/vmlinux.bin")
        # Block the binary download, not its checksum sidecar.
        environment["STOCK_TEST_BLOCK_MATCH"] = "-o"
        process = self.start("install", environment)
        self.await_barrier(ready)
        process.kill()
        process.wait(timeout=10)
        foreign = self.run_installer(STOCK_RUNTIME_OWNER="other-project:source:digest")
        self.assertNotEqual(foreign.returncode, 0)
        with self.lock.open("r+") as collector:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(collector, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual(self.binary.read_bytes(), old)
        self.assertEqual(len(list(self.host.rglob("*.tmp"))), 1)
        self.release(release)
        subprocess.run([shutil.which("flock"), "-x", str(self.lock), "true"], check=True, timeout=10)
        self.assert_success(self.run_installer())
        self.assertFalse(list(self.host.rglob("*.tmp")))
        self.assertFalse(list(self.host.rglob("*.pending")))

@unittest.skipUnless(os.environ.get("STOCK_RUNTIME_TEST_FETCH_SCRIPT"), "set STOCK_RUNTIME_TEST_FETCH_SCRIPT for pinned-helper integration")
class PinnedStockRuntimeFetchTests(StockRuntimeInstallerTests):
    def setUp(self):
        path = Path(os.environ["STOCK_RUNTIME_TEST_FETCH_SCRIPT"])
        source = path.read_bytes()
        self.assertEqual(hashlib.sha256(source).hexdigest(), PINNED_FETCH_SHA256,
                         "integration requires the unmodified helper from the locked source commit")
        self.fetch_source = source.decode()
        super().setUp()


if __name__ == "__main__":
    unittest.main()
