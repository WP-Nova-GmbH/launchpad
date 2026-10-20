import contextlib
import fcntl
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import socket
import unittest
from unittest import mock
import uuid

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("quarantine-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeJournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir="/tmp", prefix="lp-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.groups = self.root / "groups"
        self.groups.mkdir()
        self.capacity = self.root / "host-capacity.lock"
        self.patch = mock.patch.multiple(probe, CGROUP_ROOT=self.groups, CAPACITY_LOCK=self.capacity, SOCKET_ROOT=self.root / "sockets")
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def record(self, name="prepared-a"):
        output = self.root / name / "proof"
        operation = str(uuid.uuid4())
        state = {"format": "launchpad-disk-probe-operation-v1", "operationId": operation,
                 "executionMode": "direct", "cgroupPath": str(self.groups / operation),
                 "diskSha256": "a" * 64, "physicalStopConfirmed": False}
        probe.publish_operation_directory(output, state)
        return output, state

    def reconcile(self, output):
        with contextlib.redirect_stdout(io.StringIO()):
            probe.reconcile(output)

    def test_crash_before_spawn_can_reconcile_without_certifying_disk(self):
        output, state = self.record()
        self.assertFalse(Path(state["cgroupPath"]).exists())
        self.reconcile(output)
        receipt = json.loads((output / "operation.json").read_text())
        self.assertTrue(receipt["physicalStopConfirmed"])
        self.assertTrue(receipt["reconciled"])
        self.assertFalse((output / "verified.json").exists())

    def test_live_controller_blocks_reconciliation_for_every_build(self):
        first, _ = self.record("prepared-a")
        second, _ = self.record("prepared-b")
        with self.capacity.open("a+") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for output in [first, second]:
                with self.assertRaises(BlockingIOError):
                    self.reconcile(output)
                self.assertFalse(json.loads((output / "operation.json").read_text())["physicalStopConfirmed"])
        self.reconcile(second)

    def test_existing_journal_is_never_replaced(self):
        output, state = self.record()
        with self.assertRaises(FileExistsError):
            probe.publish_operation_directory(output, {"operationId": "replacement"})
        self.assertEqual(state, json.loads((output / "operation.json").read_text()))
        self.assertEqual([], list(output.parent.glob(".probe-journal-*")))

    def test_failed_publication_exposes_no_incomplete_operation(self):
        output = self.root / "proof"
        with mock.patch.object(probe, "write_private", side_effect=OSError("disk sync failed")):
            with self.assertRaises(OSError):
                probe.publish_operation_directory(output, {"operationId": "incomplete"})
        self.assertFalse(output.exists())
        self.assertEqual([], list(self.root.glob(".probe-journal-*")))

    def test_foreign_cgroup_is_not_stopped_or_certified(self):
        output, state = self.record()
        state["cgroupPath"] = str(self.root / "foreign")
        probe.write_private(output / "operation.json", state)
        with self.assertRaises(ValueError):
            self.reconcile(output)
        self.assertFalse(json.loads((output / "operation.json").read_text())["physicalStopConfirmed"])
        self.assertFalse((output / "verified.json").exists())

    def test_parent_sync_failure_leaves_a_recoverable_complete_journal(self):
        output = self.root / "proof"
        operation = str(uuid.uuid4())
        state = {"format": "launchpad-disk-probe-operation-v1", "operationId": operation,
                 "executionMode": "direct", "cgroupPath": str(self.groups / operation),
                 "physicalStopConfirmed": False}
        actual = probe.os.fsync
        calls = 0
        def sync(fd):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("parent sync failed")
            return actual(fd)
        with mock.patch.object(probe.os, "fsync", side_effect=sync):
            with self.assertRaises(OSError):
                probe.publish_operation_directory(output, state)
        self.assertEqual(state, json.loads((output / "operation.json").read_text()))
        self.reconcile(output)
        self.assertFalse((output / "verified.json").exists())


    def test_long_storage_path_uses_a_short_private_socket(self):
        output, state = self.record("very-long-storage-directory-" * 8)
        state["socketDirectory"] = str(probe.SOCKET_ROOT / state["operationId"])
        probe.write_private(output / "operation.json", state)
        path = probe.create_probe_socket(state)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path))
            self.assertLess(len(str(path).encode()), 104)
            self.assertTrue(path.exists())
        # A crash after socket allocation but before VM spawn is still recoverable.
        self.reconcile(output)
        self.assertFalse(path.parent.exists())
        self.assertFalse((output / "verified.json").exists())

    def test_socket_cleanup_never_follows_a_foreign_record(self):
        output, state = self.record()
        foreign = self.root / "foreign-socket"
        foreign.mkdir()
        state["socketDirectory"] = str(foreign)
        with self.assertRaises(ValueError):
            probe.cleanup_probe_socket(state)
        self.assertTrue(foreign.exists())


class ProbeCapacityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="lp-capacity-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.normal = self.root / "normal"
        self.probes = self.root / "probes"
        self.budget_file = self.root / "budget.json"
        self.patch = mock.patch.multiple(probe, NORMAL_CGROUP_ROOT=self.normal,
            CGROUP_ROOT=self.probes, HOST_BUDGET=self.budget_file,
            CAPACITY_LOCK=self.root / "capacity.lock")
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.memory = mock.patch.object(probe, "memory_info", return_value={
            "MemTotal": 16 * 1024 ** 3, "MemAvailable": 12 * 1024 ** 3})
        self.memory_mock = self.memory.start()
        self.addCleanup(self.memory.stop)
        self.cpu = mock.patch.object(probe.os, "sched_getaffinity", return_value=set(range(8)), create=True)
        self.cpu_mock = self.cpu.start()
        self.addCleanup(self.cpu.stop)
        for root in (self.normal, self.probes):
            root.mkdir()
            (root / "cgroup.events").write_text("populated 0\n")

    def configure(self):
        with contextlib.redirect_stdout(io.StringIO()):
            probe.configure_capacity(["--max-running-vms", "1"])

    def test_budget_reserves_one_probe_outside_ordinary_vm_capacity(self):
        self.configure()
        budget = probe.require_capacity()
        self.assertEqual(budget["maxRunningVms"], 1)
        self.assertEqual(budget["normalMemoryMaxBytes"], 5 * 1024 ** 3)
        self.assertEqual(budget["probeMemoryMaxBytes"], 5 * 1024 ** 3)
        self.assertEqual(budget["normalCpuCount"], 2)
        self.assertEqual(0, self.budget_file.stat().st_mode & 0o077)

    def test_impossible_physical_budget_is_refused_before_any_limit_changes(self):
        for arguments in ((3, 3072, 1), (1, 1024, 1), (True, 3072, 1)):
            with self.assertRaises(ValueError):
                probe.capacity_budget(*arguments)
        self.cpu_mock.return_value = set(range(4))
        with self.assertRaises(ValueError):
            self.configure()
        self.assertFalse(self.budget_file.exists())
        self.assertFalse((self.normal / "memory.max").exists())

    def test_guest_presence_blocks_reconfiguration(self):
        for root in (self.normal, self.probes):
            (root / "cgroup.events").write_text("populated 1\n")
            with self.assertRaises(RuntimeError):
                self.configure()
            (root / "cgroup.events").write_text("populated 0\n")
        self.assertFalse(self.budget_file.exists())
        self.assertFalse((self.normal / "memory.max").exists())

    def test_empty_normal_reservation_blocks_budget_edits(self):
        (self.normal / "sbx-reserved").mkdir()
        with self.assertRaises(RuntimeError):
            self.configure()
        self.assertFalse(self.budget_file.exists())

    def test_global_controller_lock_blocks_budget_edits(self):
        with probe.CAPACITY_LOCK.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.configure()
        self.assertFalse(self.budget_file.exists())

    def test_probe_requires_current_physical_headroom(self):
        self.configure()
        self.memory_mock.return_value = {"MemTotal": 16 * 1024 ** 3,
            "MemAvailable": 7 * 1024 ** 3}
        with self.assertRaisesRegex(RuntimeError, "Waiting for temporary"):
            probe.require_capacity()
        self.assertFalse((self.root / "operation.json").exists())
        self.assertFalse((self.root / "verified.json").exists())

    def test_existing_vm_growth_is_reserved_even_before_its_process_starts(self):
        self.configure()
        (self.normal / "sbx-reserved").mkdir()
        (self.normal / "memory.current").write_text(str(1024 ** 3))
        self.memory_mock.return_value = {"MemTotal": 16 * 1024 ** 3,
            "MemAvailable": 9 * 1024 ** 3}
        with self.assertRaisesRegex(RuntimeError, "Waiting for temporary"):
            probe.require_capacity()
        self.memory_mock.return_value["MemAvailable"] = 13 * 1024 ** 3
        self.assertEqual(probe.require_capacity()["maxRunningVms"], 1)

    def test_changed_host_limits_are_never_treated_as_reserved_capacity(self):
        self.configure()
        for root in (self.normal, self.probes):
            for name, value in (("memory.max", "max"), ("memory.swap.max", "max"),
                                ("cpu.max", "max 100000")):
                target = root / name
                old = target.read_text()
                target.write_text(value)
                with self.assertRaises(ValueError):
                    probe.require_capacity()
                target.write_text(old)
        self.assertEqual(probe.require_capacity()["maxRunningVms"], 1)

    def test_reboot_restores_saved_capacity_before_vm_admission(self):
        self.configure()
        original = self.budget_file.read_text()
        for root in (self.normal, self.probes):
            for child in root.iterdir():
                child.unlink()
            root.rmdir()
        with contextlib.redirect_stdout(io.StringIO()):
            probe.restore_capacity()
        self.assertEqual(probe.require_capacity()["maxRunningVms"], 1)
        self.assertEqual(self.budget_file.read_text(), original)

    def test_boot_restore_refuses_existing_vm_reservation(self):
        self.configure()
        (self.normal / "sbx-reserved").mkdir()
        (self.normal / "cpu.max").write_text("max 100000")
        original = self.budget_file.read_text()
        with self.assertRaises(RuntimeError):
            probe.restore_capacity()
        self.assertEqual((self.normal / "cpu.max").read_text(), "max 100000")
        self.assertEqual(self.budget_file.read_text(), original)

    def test_equivalent_cpu_period_survives_host_restart(self):
        self.configure()
        for root in (self.normal, self.probes):
            (root / "cpu.max").write_text("400000 200000")
        self.assertEqual(probe.require_capacity()["maxRunningVms"], 1)
        for value in ("400001 200000", "199999 100000", "max 100000",
                      "-200000 -100000", "2000 1000 extra", "0 0", "20000000 10000000"):
            (self.normal / "cpu.max").write_text(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe.require_capacity()

    def test_forged_or_public_budget_is_refused(self):
        with self.assertRaises(FileNotFoundError):
            probe.require_capacity()
        self.configure()
        self.budget_file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "Unowned"):
            probe.require_capacity()
        self.budget_file.chmod(0o600)
        budget = json.loads(self.budget_file.read_text())
        budget["probeMemoryMaxBytes"] = 1
        probe.write_private(self.budget_file, budget)
        with self.assertRaises(ValueError):
            probe.require_capacity()

    def test_failed_budget_publication_keeps_probe_unavailable(self):
        with mock.patch.object(probe, "write_private", side_effect=OSError("sync failed")):
            with self.assertRaises(OSError):
                self.configure()
        with self.assertRaises(FileNotFoundError):
            probe.require_capacity()


if __name__ == "__main__":
    unittest.main()
