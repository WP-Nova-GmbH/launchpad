import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("stock_builder", Path(__file__).with_name("build-stock-runtime.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


@unittest.skipIf(sys.version_info < (3, 12), "Stock runtime builder requires Python 3.12 or newer")
class StockRuntimeBuildTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.output = self.root / "new-runtime"
        self.archive = self.root / "fixture.tar.gz"
        self.commit = "518278060a154124a80d98f37253f8af77baf478"
        self.version = "v0.16.202610271020-stock.518278060a15"
        self.files = {
            "embed/compose/compose.yaml": json.dumps({"name": "e2b", "services": {
                "orchestrator": {"command": ["/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"]},
                "fetch-artifacts": {"volumes": ["/:/host"]},
            }}),
            "embed/compose/.env": "E2B_TOOLS_IMAGE=upstream-tools\nE2B_NODE_E2B_IMAGE=upstream-node\nE2B_ORCHESTRATOR_VERSION=old-release\n"
                                  "E2B_ENVD_VERSION=test-envd\nE2B_FIRECRACKER_VERSION=test-fc\n"
                                  "E2B_KERNEL_VERSION=test-kernel\nE2B_BUSYBOX_VERSION=test-busybox\n",
            "embed/compose/scripts/orchestrator-launch.sh": "#!/bin/bash\nexec /var/lib/e2b/bin/orchestrator\n",
            "embed/compose/docker/tools.Dockerfile": "FROM alpine:3.24\n",
            "embed/compose/docker/node-e2b.Dockerfile": "FROM node:22-alpine\nWORKDIR /app\nCOPY scripts/node/package.json scripts/node/package-lock.json ./\nRUN npm ci --omit=dev\n",
            "embed/compose/scripts/node/package.json": '{"dependencies":{"e2b":"2.61.0"}}\n',
            "embed/compose/scripts/node/package-lock.json": '{}\n',
            "packages/db/migrations/20261013190001_snapshot.sql": "SELECT 1;\n",
            "packages/db/migrations/20261023112902_latest.sql": "SELECT 2;\n",
            "packages/orchestrator/pkg/version/main.go": 'package version\nvar Version = "0.16.1"\n',
            **{"packages/" + package + "/Dockerfile": "FROM scratch\n"
               for package in ["api", "db", "client-proxy", "dashboard-api", "orchestrator"]},
        }
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, content in self.files.items():
                data = content.encode()
                info = tarfile.TarInfo("runtime-fixture/" + name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.lock = {"schemaVersion": 1, "orchestratorBuildVersion": self.version, "source": {
            "commit": self.commit, "archiveUrl": "https://example.test/stock.tar.gz",
            "commitTimestamp": "2026-10-27T10:20:42Z",
            "archiveSha256": builder.sha256(self.archive), "archiveDirectory": "runtime-fixture",
        }}
        self.calls = []

    def fake_run(self, *args):
        self.calls.append(args)
        if args[0] == "curl":
            Path(args[args.index("--output") + 1]).write_bytes(self.archive.read_bytes())
        elif args[:2] == ("docker", "build"):
            if "--iidfile" in args:
                iid = Path(args[args.index("--iidfile") + 1])
                iid.write_text("sha256:" + hashlib.sha256(iid.name.encode()).hexdigest())
            else:
                artifacts = Path(args[args.index("--output") + 1].removeprefix("type=local,dest="))
                artifacts.mkdir()
                (artifacts / "orchestrator").write_bytes(b"fixture native orchestrator")
        else:
            self.fail("unexpected command: " + repr(args))

    def test_prepares_source_bound_artifacts_without_starting_or_replacing_a_deployment(self):
        old = self.root / "existing-runtime"
        old.mkdir()
        (old / "sentinel").write_text("unchanged")
        with patch.object(builder, "run", side_effect=self.fake_run):
            builder.build(self.output, "arm64", self.lock)
        receipt = json.loads((self.output / "build.json").read_text())
        images = receipt["images"]
        self.assertEqual(set(images), {"api", "db-migrator", "client-proxy", "dashboard-api", "tools", "node-e2b"})
        self.assertEqual(receipt["sourceCommit"], self.commit)
        self.assertEqual(receipt["orchestratorBuildVersion"], self.version)
        self.assertEqual(receipt["expectedMigration"], "20261023112902")
        self.assertEqual(receipt["orchestratorSha256"], builder.sha256(self.output / "artifacts/orchestrator"))
        self.assertEqual((old / "sentinel").read_text(), "unchanged")
        for name, content in self.files.items():
            self.assertEqual((self.output / "source/runtime-fixture" / name).read_text(), content)
        self.assertEqual(len(self.calls), 8)  # Download, six images, native artifacts.
        for command in self.calls[1:]:
            self.assertEqual(command[:2], ("docker", "build"))
            self.assertIn("linux/arm64", command)
        self.assertIn("COMMIT_SHA=" + self.commit, self.calls[-1])
        self.assertIn("VERSION=" + self.version, self.calls[-1])
        self.assertIn("artifacts", self.calls[-1])
        native = json.loads((self.output / "runtime.override.json").read_text())
        for role in ["api", "db-migrator", "client-proxy", "dashboard-api"]:
            self.assertEqual(native["services"][role]["image"], images[role]["id"])
            self.assertEqual(native["services"][role]["environment"]["LAUNCH_DARKLY_API_KEY"], "")
        self.assertEqual(native["services"]["orchestrator"], {"environment": {"LAUNCH_DARKLY_API_KEY": ""}})
        defaults = (self.output / ".env").read_text()
        self.assertIn("E2B_TOOLS_IMAGE=" + images["tools"]["id"], defaults)
        self.assertIn("E2B_NODE_E2B_IMAGE=" + images["node-e2b"]["id"], defaults)
        self.assertNotIn("node-e2b", native["services"])
        helper = next(call for call in self.calls[1:] if "node-e2b.image-id" in str(call))
        self.assertEqual(helper[helper.index("--file")+1], str(self.output / "source/runtime-fixture/embed/compose/docker/node-e2b.Dockerfile"))
        self.assertEqual(helper[-1], str(self.output / "source/runtime-fixture/embed/compose"))
        self.assertEqual([line for line in defaults.splitlines() if line.startswith("HUGEPAGES=")],
                         ["HUGEPAGES=4096"])
        staging = json.loads((self.output / "compose.override.yaml").read_text())["services"]["fetch-artifacts"]
        self.assertEqual(staging["command"], ["/bin/bash", "/stock/install-orchestrator.sh"])
        self.assertEqual(staging["pid"], "host")
        self.assertEqual(staging["cgroup"], "host")
        self.assertIn(receipt["composeProject"], staging["environment"]["STOCK_RUNTIME_OWNER"])
        preflight = json.loads((self.output / "compose.override.yaml").read_text())["services"]["preflight"]
        self.assertEqual(preflight["command"], ["/bin/bash", "/stock/install-orchestrator.sh", "preflight"])
        self.assertEqual(preflight["environment"], staging["environment"])
        self.assertTrue(all(mount["read_only"] for mount in preflight["volumes"]))
        setup = json.loads((self.output / "compose.override.yaml").read_text())["services"]["host-setup"]
        self.assertEqual(setup["command"], ["/bin/bash", "/stock/install-orchestrator.sh", "setup"])
        self.assertEqual(setup["environment"], staging["environment"])
        self.assertEqual(setup["pid"], "host")
        self.assertEqual(setup["cgroup"], "host")
        self.assertIn(artifact_mount := {"type": "bind", "source": str(self.output / "artifacts"),
                                        "target": "/stock", "read_only": True}, setup["volumes"])
        self.assertIn(artifact_mount, staging["volumes"])
        teardown = json.loads((self.output / "compose.override.yaml").read_text())["services"]["host-teardown"]
        self.assertEqual(teardown["command"], [])
        self.assertEqual(teardown["entrypoint"][:2], ["/bin/sh", "-c"])
        self.assertIn("unsupported", teardown["entrypoint"][2])
        self.assertIn("exit 1", teardown["entrypoint"][2])
        for name, digest in receipt["configurationSha256"].items():
            self.assertEqual(digest, builder.sha256(self.output / name))
        self.assertEqual((self.output / "configure-project.py").read_bytes(),
                         Path(__file__).with_name("configure-stock-project.py").read_bytes())
        config = json.loads((self.output / "collector.example.json").read_text())
        self.assertEqual(config["project"], receipt["composeProject"])
        self.assertEqual(config["storagePath"], "/var/lib/e2b/storage/templates")
        self.assertEqual(config["buildCachePath"], "/var/lib/e2b/storage/build-cache")
        subprocess.run(["bash", "-n", str(self.output / "artifacts/install-orchestrator.sh")], check=True)
        with patch.object(builder, "run") as command:
            with self.assertRaises(FileExistsError):
                builder.build(self.output, "arm64", self.lock)
            command.assert_not_called()

    def test_bad_source_checksum_never_builds_images_or_publishes_a_receipt(self):
        self.lock["source"]["archiveSha256"] = "0" * 64
        with patch.object(builder, "run", side_effect=self.fake_run):
            with self.assertRaisesRegex(ValueError, "checksum"):
                builder.build(self.output, "amd64", self.lock)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse((self.output / "build.json").exists())
        self.assertFalse((self.output / "compose.yaml").exists())

    def test_invalid_or_misleading_orchestrator_versions_never_download_or_build(self):
        for version in (None, 1, "", "stock-" + self.commit[:12], "v0.16.202610281020-stock." + self.commit[:12],
                        "v0.16.202610271020-stock.aaaaaaaaaaaa", "v0.16.999999999999-stock." + self.commit[:12]):
            with self.subTest(version=version), patch.object(builder, "run") as command:
                self.lock["orchestratorBuildVersion"] = version
                with self.assertRaises(ValueError):
                    builder.build(self.output, "arm64", self.lock)
                command.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_native_release_line_mismatch_never_builds_images(self):
        self.lock["orchestratorBuildVersion"] = self.version.replace("v0.16.", "v0.17.")
        with patch.object(builder, "run", side_effect=self.fake_run):
            with self.assertRaisesRegex(ValueError, "native release line"):
                builder.build(self.output, "arm64", self.lock)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse((self.output / "build.json").exists())

    def test_failed_build_never_publishes_deployment_configuration(self):
        def fail_docker(*args):
            if args[0] == "docker":
                raise subprocess.CalledProcessError(1, args)
            self.fake_run(*args)
        with patch.object(builder, "run", side_effect=fail_docker):
            with self.assertRaises(subprocess.CalledProcessError):
                builder.build(self.output, "arm64", self.lock)
        self.assertFalse((self.output / "build.json").exists())
        self.assertFalse((self.output / "compose.yaml").exists())

    def test_preflight_refuses_existing_state_without_host_writes(self):
        script = self.root / "install-orchestrator.sh"
        script.write_text(builder.INSTALLER)
        for action in ["preflight"]:
            for existing in ["binary", "storage", "owner", "dangling owner"]:
                with self.subTest(action=action, existing=existing):
                    host = self.root / (action + "-" + existing.replace(" ", "-"))
                    state = host / "var/lib/e2b"
                    state.mkdir(parents=True)
                    owner = state / "launchpad-stock-runtime-owner"
                    if existing == "binary":
                        (state / "bin").mkdir()
                        sentinel = state / "bin/orchestrator"
                        sentinel.write_text("existing native binary")
                    elif existing == "storage":
                        sentinel = state / "storage/templates/retained-disk"
                        sentinel.parent.mkdir(parents=True)
                        sentinel.write_text("retained snapshot bytes")
                    elif existing == "owner":
                        sentinel = owner
                        sentinel.write_text("another-project:another-source")
                    else:
                        sentinel = state / "sentinel"
                        sentinel.write_text("unrelated state")
                        owner.symlink_to(state / "missing-owner")
                    before = sentinel.read_bytes()
                    result = subprocess.run(["bash", str(script), action], env={
                        **os.environ, "HOST_ROOT": str(host),
                        "STOCK_RUNTIME_OWNER": "fixture-project:" + self.commit + ":" + "a" * 64,
                        "STOCK_ORCHESTRATOR_SHA256": "a" * 64,
                    }, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("stock-runtime:", result.stderr)
                    self.assertNotIn("/opt/e2b/scripts", result.stderr)
                    self.assertEqual(sentinel.read_bytes(), before)
                    if existing in ["binary", "storage"]:
                        self.assertFalse(owner.exists())
                    if existing == "dangling owner":
                        self.assertTrue(owner.is_symlink())

    def test_installer_requires_a_complete_restored_collector_receipt(self):
        # Exercise the shipped jq validation using the collector's wire format.
        # Host ownership/flock checks remain outside this host-free protocol test.
        match = re.search(r"  jq -es --arg project [^\n]+ '\n(.*?)\n  ' \"\$receipt\"", builder.INSTALLER, re.S)
        self.assertIsNotNone(match)
        query = match[1]
        writers, orchestrator, database = ["a" * 64], "b" * 64, "c" * 64
        receipt = {"schemaVersion": 1, "identity": {
            "project": "fixture-project", "storagePath": "/var/lib/e2b/storage/templates",
            "buildCachePath": "/var/lib/e2b/storage/build-cache", "orchestratorAddress": "127.0.0.1:5008",
        }, "phase": "restored", "deployment": {
            "Writers": writers, "Orchestrator": orchestrator, "Database": database,
            "Roles": {writers[0]: "api", orchestrator: "orchestrator", database: "postgres"},
        }, "attemptedStopIds": [*writers, orchestrator]}

        def accepts(value, trailing=""):
            result = subprocess.run(["jq", "-es", "--arg", "project", "fixture-project", query],
                                    input=json.dumps(value) + trailing, capture_output=True, text=True)
            return result.returncode == 0

        self.assertTrue(accepts(receipt))
        self.assertFalse(accepts({**receipt, "phase": "pending"}, "\n" + json.dumps(receipt)))
        self.assertFalse(accepts(receipt, "\n" + json.dumps(receipt)))
        for phase in ("pending", "restoring", "unknown", None):
            with self.subTest(phase=phase):
                self.assertFalse(accepts({**receipt, "phase": phase}))
        for change in (
            {"schemaVersion": 2}, {"extra": True}, {"deployment": {}},
            {"identity": {**receipt["identity"], "project": "another-project"}},
            {"identity": {**receipt["identity"], "storagePath": "/another/store"}},
            {"deployment": {**receipt["deployment"], "Writers": [writers[0], writers[0]]}},
            {"deployment": {**receipt["deployment"], "Roles": {}}},
            {"attemptedStopIds": [orchestrator]},
            {"attemptedStopIds": [*writers, "d" * 64]},
            {"attemptedStopIds": [*writers, *writers]},
            {"attemptedStopIds": None},
        ):
            with self.subTest(change=change):
                self.assertFalse(accepts({**receipt, **change}))


if __name__ == "__main__":
    unittest.main()
