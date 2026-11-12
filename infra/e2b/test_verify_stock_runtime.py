import copy
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import stat
import sys
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("stock_verify", Path(__file__).with_name("verify-stock-runtime.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
maintenance_lock = verify.maintenance_lock
verify_kernel = verify.verify_kernel


class StockStartupTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        for name in (*verify.CONFIG_FILES, "artifacts/orchestrator", "artifacts/install-orchestrator.sh"):
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(name)
        self.receipt = {
            "schemaVersion": 1, "sourceCommit": verify.SOURCE,
            "sourceArchiveSha256": verify.SOURCE_ARCHIVE_SHA256,
            "orchestratorBuildVersion": verify.VERSION, "platform": "linux/arm64",
            "composeProject": "launchpad-e2b-stock-0123456789abcdef",
            "configurationSha256": {name: verify.sha(self.root / name) for name in verify.CONFIG_FILES},
            "orchestratorSha256": verify.sha(self.root / "artifacts/orchestrator"),
            "installerSha256": verify.sha(self.root / "artifacts/install-orchestrator.sh"),
            "images": {name: {"id": "sha256:" + str(index) * 64} for index, name in enumerate(verify.IMAGE_ROLES)},
        }
        self.write_receipt()
        (self.root / "stock-runtime.lock.json").write_text(json.dumps({
            "source": {"commit": verify.SOURCE, "archiveSha256": verify.SOURCE_ARCHIVE_SHA256},
            "orchestratorBuildVersion": verify.VERSION,
        }))
        self.configuration = {"name": self.receipt["composeProject"], "services": {}}
        services = self.configuration["services"]
        for name in ("api", "client-proxy", "db-migrator", "dashboard-api"):
            services[name] = {"image": self.receipt["images"][name]["id"]}
        for name in verify.TOOLS_SERVICES:
            services[name] = {"image": self.receipt["images"]["tools"]["id"]}
        for name in ("base-template", "smoke"):
            services[name] = {"image": self.receipt["images"]["node-e2b"]["id"]}
        services["orchestrator"].update({"network_mode": "host", "pid": "host", "cgroup": "host", "privileged": True,
            "command": ["/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"],
            "environment": {"ORCHESTRATOR_SERVICES": "orchestrator,template-manager", "TEMPLATE_STORAGE_URL": "file:///var/lib/e2b/storage/templates", "BUILD_CACHE_STORAGE_URL": "file:///var/lib/e2b/storage/build-cache"}})
        self.pg = {"Id": "a" * 64, "State": {"Running": True}, "Config": {"Labels": {
            "com.docker.compose.project": self.receipt["composeProject"], "com.docker.compose.service": "postgres"}}}
        self.calls = []
        self.limits = {"diskMb": 32768, "maxLengthHours": 48}
        for name, replacement in (("maintenance_lock", contextlib.nullcontext), ("verify_kernel", Mock()), ("verify_maintenance", Mock())):
            patcher = patch.object(verify, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_receipt(self):
        (self.root / "build.json").write_text(json.dumps(self.receipt))

    def docker_run(self, *args, input=None):
        self.calls.append((args, input))
        if args[-3:] == ("config", "--format", "json"):
            configuration = copy.deepcopy(self.configuration)
            if args[-5:-3] != ("--profile", "*"):
                # Native teardown is profile-gated and absent from default config.
                configuration["services"].pop("host-teardown")
                configuration["services"].pop("smoke")
            return json.dumps(configuration)
        if args[-3:] == ("ps", "--quiet", "postgres"):
            return self.pg["Id"]
        if args[:2] == ("docker", "inspect"):
            return json.dumps([self.pg])
        if args[:2] == ("docker", "exec"):
            return json.dumps(self.limits) if self.limits else ""
        return ""

    def test_source_configuration_and_all_six_images_must_match_before_startup(self):
        with patch.object(verify.platform, "machine", return_value="aarch64"):
            self.assertEqual(verify.load(self.root)[1], self.receipt)
        verify.verify_configuration(self.receipt, self.configuration)
        (self.root / "compose.yaml").write_text("another configuration")
        with patch.object(verify.platform, "machine", return_value="aarch64"), patch.object(verify, "run") as run:
            with self.assertRaisesRegex(ValueError, "configuration differs"):
                verify.verify(self.root, "b" * 64, True)
            run.assert_not_called()

    def test_legacy_or_wrong_architecture_is_rejected_without_docker(self):
        for key, value in (("sourceCommit", "legacy"), ("platform", "linux/amd64"), ("orchestratorBuildVersion", "stock-not-semver")):
            with self.subTest(key=key):
                prior = self.receipt[key]
                self.receipt[key] = value
                self.write_receipt()
                with patch.object(verify.platform, "machine", return_value="aarch64"), patch.object(verify, "run") as run:
                    with self.assertRaises(ValueError):
                        verify.verify(self.root, "b" * 64, True)
                    run.assert_not_called()
                self.receipt[key] = prior
        self.write_receipt()

    def test_native_launcher_and_private_storage_profile_reject_overrides(self):
        for key, value in (("command", ["custom"]), ("entrypoint", ["/bin/sh"]), ("pid", "private"), ("privileged", False)):
            changed = copy.deepcopy(self.configuration)
            changed["services"]["orchestrator"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify.verify_configuration(self.receipt, changed)
        for key, value in (("OL_COMMAND", "custom"), ("LAUNCH_DARKLY_API_KEY", "a-key"), ("TEMPLATE_STORAGE_URL", "file:///another")):
            changed = copy.deepcopy(self.configuration)
            changed["services"]["orchestrator"]["environment"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify.verify_configuration(self.receipt, changed)
        changed = copy.deepcopy(self.configuration)
        changed["services"]["base-template"]["image"] = "released-helper"
        with self.assertRaisesRegex(ValueError, "SDK image"):
            verify.verify_configuration(self.receipt, changed)

    def test_validation_includes_native_optional_profiles_without_starting_them(self):
        self.configuration["services"]["host-teardown"]["profiles"] = ["purge"]
        self.configuration["services"]["smoke"]["profiles"] = ["test"]
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", return_value=True), patch.object(verify, "verify_host"):
            verify.verify(self.root, "b" * 64, True)
        commands = [args for args, _ in self.calls]
        validations = [args for args in commands if args[-3:] == ("config", "--format", "json")]
        self.assertEqual(len(validations), 2)
        self.assertTrue(all(args[-5:-3] == ("--profile", "*") for args in validations))
        self.assertTrue(all("--profile" not in args for args in commands if "up" in args or "run" in args))

    def test_restart_preserves_custom_native_lifetime_without_configuration_writes(self):
        command = verify.compose(self.root, self.receipt)
        with patch.object(verify, "run", side_effect=self.docker_run):
            verify.configure_limits(self.root, self.receipt, command)
        self.assertEqual(len(self.calls), 3)
        self.assertFalse(any("configure-project.py" in str(args) for args, _ in self.calls))
        self.assertIn(verify.PROJECT_ID, self.calls[-1][1])

    def test_missing_limits_configures_exact_seed_project_before_api_start(self):
        self.limits = None
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", return_value=False), patch.object(verify, "verify_host"):
            verify.verify(self.root, "b" * 64, True)
        commands = [args for args, _ in self.calls]
        seed = next(i for i, args in enumerate(commands) if args[-4:] == ("run", "--rm", "--no-deps", "seed"))
        configure = next(i for i, args in enumerate(commands) if str(self.root / "configure-project.py") in args)
        api = next(i for i, args in enumerate(commands) if args[-3:] == ("api", "client-proxy", "dashboard-api"))
        self.assertLess(seed, configure)
        self.assertLess(configure, api)
        self.assertEqual(commands[configure][-2:], ("--project-id", verify.PROJECT_ID))
        jobs = [args[-1] for args in commands if args[-4:-1] == ("run", "--rm", "--no-deps")]
        self.assertEqual(jobs, ["preflight", "host-setup", "fetch-artifacts", "db-migrator", "seed", "clickhouse-migrator", "api-secrets"])
        self.assertTrue(all("--no-deps" in args for args in commands if "up" in args))
        migrate = next(i for i, args in enumerate(commands) if args[-1] == "db-migrator")
        databases = next(i for i, args in enumerate(commands) if args[-3:] == ("postgres", "redis", "clickhouse"))
        secrets = next(i for i, args in enumerate(commands) if args[-1] == "api-secrets")
        vector = next(i for i, args in enumerate(commands) if args[-1] == "vector")
        self.assertLess(databases, migrate)
        self.assertLess(migrate, seed)
        self.assertLess(configure, secrets)
        self.assertLess(secrets, vector)
        self.assertLess(vector, api)

    def test_failed_one_shot_never_starts_native_writers(self):
        for service in ("db-migrator", "seed", "clickhouse-migrator", "api-secrets"):
            self.calls = []
            def failed_job(*args, input=None):
                value = self.docker_run(*args, input=input)
                if args[-4:] == ("run", "--rm", "--no-deps", service):
                    raise ValueError("native one-shot failed")
                return value
            with self.subTest(service=service), patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=failed_job), patch.object(verify, "verify_exclusive_host", return_value=False), patch.object(verify, "verify_host"):
                with self.assertRaisesRegex(ValueError, "one-shot failed"):
                    verify.verify(self.root, "b" * 64, True)
            self.assertFalse(any("up" in args and any(writer in args for writer in ("orchestrator", "api", "client-proxy", "dashboard-api")) for args, _ in self.calls))
            if service in ("db-migrator", "seed"):
                self.assertFalse(any(args[:2] == ("docker", "exec") for args, _ in self.calls))

    def test_running_host_missing_kernel_setup_never_starts_or_repairs_services(self):
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", return_value=True), patch.object(verify, "verify_host"), patch.object(verify, "verify_kernel", side_effect=ValueError("explicitly stop")):
            with self.assertRaisesRegex(ValueError, "explicitly stop"):
                verify.verify(self.root, "b" * 64, True)
        self.assertEqual(len(self.calls), 1)

    def test_maintenance_contention_prevents_any_start_or_setup_on_running_host(self):
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", return_value=True), patch.object(verify, "verify_host"), patch.object(verify, "maintenance_lock", side_effect=ValueError("maintenance is active")):
            with self.assertRaisesRegex(ValueError, "maintenance is active"):
                verify.verify(self.root, "b" * 64, True)
        self.assertEqual(len(self.calls), 1)

    def test_stopped_host_is_revalidated_under_lock_before_start(self):
        @contextlib.contextmanager
        def locked():
            self.calls.append((("lock",), None))
            yield
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", side_effect=[False, ValueError("foreign deployment appeared")]), patch.object(verify, "verify_host"), patch.object(verify, "maintenance_lock", locked):
            with self.assertRaisesRegex(ValueError, "foreign deployment appeared"):
                verify.verify(self.root, "b" * 64, True)
        commands = [args for args, _ in self.calls]
        self.assertLess(next(i for i, args in enumerate(commands) if args[-1] == "fetch-artifacts"), commands.index(("lock",)))
        self.assertFalse(any("up" in args for args in commands))

    def test_unfinished_maintenance_blocks_setup_and_rechecks_before_writer_start(self):
        for checks in ([ValueError("collector --apply")], [None, ValueError("collector --apply")]):
            self.calls = []
            with self.subTest(checks=len(checks)), patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", return_value=False), patch.object(verify, "verify_host"), patch.object(verify, "verify_maintenance", side_effect=checks):
                with self.assertRaisesRegex(ValueError, "collector --apply"):
                    verify.verify(self.root, "b" * 64, True)
            commands = [args for args, _ in self.calls]
            self.assertFalse(any("up" in args for args in commands))
            if len(checks) == 1:
                self.assertFalse(any(args[-4:-1] == ("run", "--rm", "--no-deps") for args in commands))

    def test_foreign_postgres_never_receives_a_query_or_configuration_write(self):
        self.pg["Config"]["Labels"]["com.docker.compose.project"] = "another-project"
        with patch.object(verify, "run", side_effect=self.docker_run), self.assertRaisesRegex(ValueError, "PostgreSQL ownership"):
            verify.configure_limits(self.root, self.receipt, verify.compose(self.root, self.receipt))
        self.assertEqual(len(self.calls), 2)

    def test_verification_failure_never_starts_seed_or_api(self):
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=self.docker_run), patch.object(verify, "verify_exclusive_host", side_effect=ValueError("foreign deployment")):
            with self.assertRaisesRegex(ValueError, "foreign deployment"):
                verify.verify(self.root, "b" * 64, True)
        self.assertEqual(len(self.calls), 1)

    def test_failed_fresh_project_configuration_never_starts_api(self):
        self.limits = None
        def fail_configure(*args, input=None):
            if str(self.root / "configure-project.py") in args:
                raise ValueError("existing project cannot change limits")
            return self.docker_run(*args, input=input)
        with patch.object(verify, "load", return_value=(self.root, self.receipt)), patch.object(verify, "run", side_effect=fail_configure), patch.object(verify, "verify_exclusive_host", return_value=False), patch.object(verify, "verify_host"):
            with self.assertRaisesRegex(ValueError, "existing project"):
                verify.verify(self.root, "b" * 64, True)
        self.assertFalse(any(args[-3:] == ("api", "client-proxy", "dashboard-api") for args, _ in self.calls))

    def test_foreign_or_mismatched_running_orchestrator_is_never_restarted(self):
        container = {"Id": "b" * 64, "Image": self.receipt["images"]["tools"]["id"],
            "Config": {"Labels": {"com.docker.compose.project": self.receipt["composeProject"]},
                       "Cmd": ["/bin/bash", "/opt/e2b/scripts/orchestrator-launch.sh"],
                       "Env": ["ORCHESTRATOR_SERVICES=orchestrator,template-manager"]},
            "HostConfig": {"NetworkMode": "host", "PidMode": "host", "CgroupnsMode": "host", "Privileged": True}}
        def inspect(*args, input=None):
            self.calls.append((args, input))
            return container["Id"] if args[1] == "ps" else json.dumps([container])
        with patch.object(verify, "run", side_effect=inspect):
            self.assertTrue(verify.verify_exclusive_host(self.receipt))
            container["HostConfig"]["CgroupnsMode"] = "private"
            with self.assertRaisesRegex(ValueError, "running deployment differs"):
                verify.verify_exclusive_host(self.receipt)
            container["Config"]["Labels"]["com.docker.compose.project"] = "another-runtime"
            with self.assertRaisesRegex(ValueError, "Another E2B deployment"):
                verify.verify_exclusive_host(self.receipt)
        self.assertTrue(all(args[:2] in (("docker", "ps"), ("docker", "inspect")) for args, _ in self.calls))

    def test_installed_owner_and_firewall_must_match_and_orphans_block_start(self):
        for name in ("var/lib/e2b/launchpad-stock-runtime-owner", "var/lib/e2b/bin/orchestrator", "etc/launchpad/host-firewall.nft", "usr/local/libexec/launchpad-host-firewall"):
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("policy" if name.endswith(".nft") else "artifacts/orchestrator")
        owner = self.root / "var/lib/e2b/launchpad-stock-runtime-owner"
        owner.write_text(f"{self.receipt['composeProject']}:{verify.SOURCE}:{self.receipt['orchestratorSha256']}")
        digest = hashlib.sha256(b"policy").hexdigest()
        with patch.object(verify, "root_file"), patch.object(verify, "run") as run:
            verify.verify_host(self.receipt, digest, False, self.root)
            run.assert_called_once_with(str(self.root / "usr/local/libexec/launchpad-host-firewall"), "check")
            with self.assertRaisesRegex(ValueError, "firewall policy"):
                verify.verify_host(self.receipt, "b" * 64, False, self.root)
            events = self.root / "sys/fs/cgroup/e2b/known/cgroup.events"
            events.parent.mkdir(parents=True)
            events.write_text("populated 1\n")
            with self.assertRaisesRegex(ValueError, "workloads remain"):
                verify.verify_host(self.receipt, digest, False, self.root)
            owner.write_text("another deployment")
            with self.assertRaisesRegex(ValueError, "belongs to another"):
                verify.verify_host(self.receipt, digest, False, self.root)

    def test_root_controls_refuse_writable_symlinked_or_unowned_files(self):
        file = Mock()
        file.is_symlink.return_value = False
        file.is_file.return_value = True
        for uid, mode, links in ((1000, 0o644, 1), (0, 0o666, 1), (0, 0o644, 2)):
            file.lstat.return_value = types.SimpleNamespace(st_uid=uid, st_mode=mode, st_nlink=links)
            with self.assertRaises(ValueError):
                verify.root_file(file)
        file.lstat.return_value = types.SimpleNamespace(st_uid=0, st_mode=0o644, st_nlink=1)
        verify.root_file(file)
        file.is_symlink.return_value = True
        with self.assertRaises(ValueError):
            verify.root_file(file)


class NativeKernelAndLockTests(unittest.TestCase):
    def test_only_complete_private_restored_maintenance_receipt_permits_startup(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch).resolve()
            project = "launchpad-e2b-stock-0123456789abcdef"
            config = {"schemaVersion": 1, "project": project, "storagePath": "/var/lib/e2b/storage/templates", "buildCachePath": "/var/lib/e2b/storage/build-cache", "orchestratorAddress": "127.0.0.1:5008", "journalPath": verify.COLLECTOR_JOURNAL}
            (directory / "collector.example.json").write_text(json.dumps(config))
            path = directory / (verify.COLLECTOR_JOURNAL + ".maintenance.json").lstrip("/")
            path.parent.mkdir(parents=True)
            record = {"schemaVersion": 1, "identity": {key: config[key] for key in ("project", "storagePath", "buildCachePath", "orchestratorAddress")}, "phase": "restored", "deployment": {"Writers": ["a" * 64], "Orchestrator": "b" * 64, "Database": "c" * 64, "Roles": {"a" * 64: "api", "b" * 64: "orchestrator", "c" * 64: "postgres"}}, "attemptedStopIds": ["a" * 64, "b" * 64]}
            original_fstat = os.fstat
            def root_descriptor(fd):
                info = original_fstat(fd)
                return types.SimpleNamespace(st_uid=0, st_nlink=info.st_nlink, st_mode=info.st_mode)
            with patch.object(verify.os, "fstat", side_effect=root_descriptor):
                verify.verify_maintenance(directory, {"composeProject": project}, directory)
                path.write_text(json.dumps(record))
                path.chmod(0o600)
                verify.verify_maintenance(directory, {"composeProject": project}, directory)
                for phase in ("pending", "restoring", "unknown"):
                    changed = {**record, "phase": phase}
                    path.write_text(json.dumps(changed))
                    with self.subTest(phase=phase), self.assertRaisesRegex(ValueError, "--apply"):
                        verify.verify_maintenance(directory, {"composeProject": project}, directory)
                for change in ({"schemaVersion": True}, {"identity": {}}, {"deployment": {}}, {"attemptedStopIds": ["b" * 64]}, {"attemptedStopIds": ["d" * 64]}, {"extra": True}):
                    path.write_text(json.dumps({**record, **change}))
                    with self.subTest(change=change), self.assertRaisesRegex(ValueError, "--apply"):
                        verify.verify_maintenance(directory, {"composeProject": project}, directory)
                for content in ("invalid", json.dumps(record) + "{}", " " * 65537):
                    path.write_text(content)
                    with self.assertRaisesRegex(ValueError, "--apply"):
                        verify.verify_maintenance(directory, {"composeProject": project}, directory)
                path.write_text(json.dumps(record))
                path.chmod(0o644)
                with self.assertRaisesRegex(ValueError, "--apply"):
                    verify.verify_maintenance(directory, {"composeProject": project}, directory)
                path.unlink()
                path.symlink_to(directory / "collector.example.json")
                with self.assertRaisesRegex(ValueError, "--apply"):
                    verify.verify_maintenance(directory, {"composeProject": project}, directory)

    def test_command_waits_for_successful_exit_and_rejects_nonzero_without_child_output(self):
        self.assertEqual(verify.run(sys.executable, "-c", "print('completed')"), "completed\n")
        with self.assertRaisesRegex(ValueError, "Stock runtime command failed") as error:
            verify.run(sys.executable, "-c", "import sys; print('private failure'); sys.exit(7)")
        self.assertNotIn("private failure", str(error.exception))

    def test_real_contended_lock_refuses_and_releases_without_replacing_inode(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch).resolve() / "maintenance.lock"
            path.write_bytes(b"")
            path.chmod(0o600)
            original_fstat = os.fstat
            def root_descriptor(fd):
                info = original_fstat(fd)
                return types.SimpleNamespace(st_uid=0, st_nlink=info.st_nlink, st_mode=info.st_mode, st_dev=info.st_dev, st_ino=info.st_ino)
            with patch.object(verify, "root_file"), patch.object(verify.os, "fstat", side_effect=root_descriptor):
                with path.open("r+") as held:
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaisesRegex(ValueError, "maintenance is active"):
                        with maintenance_lock(path):
                            self.fail("contended startup entered its critical section")
                inode = path.stat().st_ino
                with maintenance_lock(path):
                    self.assertEqual(path.stat().st_ino, inode)
                with path.open("r+") as released:
                    fcntl.flock(released, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_running_kernel_uses_total_hugepages_and_rejects_reboot_state(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            values = {"proc/sys/vm/nr_hugepages": "4096", "sys/module/nbd/parameters/nbds_max": "64", "proc/sys/net/ipv4/tcp_max_syn_backlog": "65535", "proc/sys/vm/max_map_count": "1048576", "proc/meminfo": "HugePages_Free: 0\nHugepagesize: 2048 kB\n"}
            for name, value in values.items():
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(value)
            (root / "var/run/netns").mkdir(parents=True)
            original_stat = Path.stat
            def device_stat(path, *args, **kwargs):
                if path == root / "dev/nbd0":
                    return types.SimpleNamespace(st_mode=stat.S_IFBLK)
                if path in (root / "dev/kvm", root / "dev/net/tun"):
                    return types.SimpleNamespace(st_mode=stat.S_IFCHR)
                return original_stat(path, *args, **kwargs)
            configuration = {"services": {"host-setup": {"environment": {"HUGEPAGES": "4096", "NBDS_MAX": "64"}}}}
            with patch.object(Path, "stat", device_stat), patch.object(verify, "run") as run:
                verify_kernel(configuration, root)
                self.assertIn("--clamp-mss-to-pmtu", run.call_args.args)
                (root / "proc/sys/vm/nr_hugepages").write_text("0")
                with self.assertRaisesRegex(ValueError, "explicitly stop"):
                    verify_kernel(configuration, root)
                (root / "proc/sys/vm/nr_hugepages").write_text("4096")
                (root / "var/run/netns").rmdir()
                with self.assertRaisesRegex(ValueError, "explicitly stop"):
                    verify_kernel(configuration, root)


if __name__ == "__main__":
    unittest.main()
