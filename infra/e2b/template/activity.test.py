import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import venv

spec = importlib.util.spec_from_file_location("activity", Path(__file__).with_name("activity.py"))
activity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activity)


class HelperStartupTests(unittest.TestCase):
    def test_writable_system_site_hooks_do_not_run_before_helpers(self):
        with tempfile.TemporaryDirectory(prefix="launchpad-python-isolation-") as directory:
            root = Path(directory)
            venv.EnvBuilder(with_pip=False).create(root / "python")
            python = root / "python/bin/python"
            site_packages = Path(subprocess.run(
                [str(python), "-I", "-B", "-c", "import site; print(site.getsitepackages()[0])"],
                check=True, capture_output=True, text=True,
            ).stdout.strip())
            marker = root / "pth-ran"
            (site_packages / "launchpad-proof.pth").write_text(
                f"import pathlib; pathlib.Path({str(marker)!r}).write_text('injected')\n"
            )
            # Prove this is an executable system-site hook even in isolated mode.
            subprocess.run([str(python), "-I", "-B", "-c", "pass"], check=True)
            self.assertTrue(marker.exists())
            for helper in ("activity.py", "workload.py"):
                with self.subTest(helper=helper):
                    marker.unlink(missing_ok=True)
                    script = Path(__file__).with_name(helper)
                    _, arguments = script.read_text().splitlines()[0][2:].split(maxsplit=1)
                    subprocess.run([
                        str(python), arguments, "-B", "-c",
                        "import runpy,sys; runpy.run_path(sys.argv[1], run_name='isolated_helper')",
                        str(script),
                    ], check=True)
                    self.assertFalse(marker.exists())


class DurableActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="launchpad-activity-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.sqlite"
        self.writer = sqlite3.connect(self.path)
        self.addCleanup(self.writer.close)
        self.writer.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE thread_execution_fences(thread_id TEXT,environment_id TEXT,generation INT,phase TEXT,
                project_id TEXT,operation_id TEXT);
            CREATE TABLE projection_threads(thread_id TEXT,archived_at TEXT,deleted_at TEXT,
                pending_approval_count INT DEFAULT 0,pending_user_input_count INT DEFAULT 0);
            CREATE TABLE projection_thread_sessions(thread_id TEXT PRIMARY KEY,status TEXT,provider_name TEXT,active_turn_id TEXT);
            CREATE TABLE projection_thread_prompt_queues(thread_id TEXT,state_json TEXT);
            CREATE TABLE projection_turns(thread_id TEXT,completed_at TEXT,state TEXT,checkpoint_status TEXT);
            CREATE TABLE thread_execution_work(thread_id TEXT,work_id TEXT,generation INT,kind TEXT,started INT,completed INT,relay_completed INT);
            INSERT INTO thread_execution_fences VALUES('thread','environment',1,'active','project','enroll');
            INSERT INTO projection_threads(thread_id) VALUES('thread');
        """)
        self.queue = {"enabled": True, "handoff": None, "awaitingTurnId": None, "entries": []}

    def enqueue(self, queue):
        self.writer.execute("DELETE FROM projection_thread_prompt_queues")
        self.writer.execute("INSERT INTO projection_thread_prompt_queues VALUES('thread',?)", (json.dumps(queue),))
        self.writer.commit()

    def test_reads_acknowledged_queue_from_wal_and_redacts_message_and_identity_data(self):
        self.enqueue({**self.queue, "entries": [{"kind": "move", "state": "pending", "detail": "secret", "author": {"token": "secret"}}, {"state": "pending", "text": "secret", "attachments": [{"secret": "secret"}]}]})
        result = activity.projection_activity(self.path)
        self.assertEqual(result["queue"]["entries"], [{"state": "pending"}, {"state": "pending"}])
        self.assertNotIn("secret", json.dumps(result))
        self.assertFalse(result["unfinished"])
        self.assertTrue(Path(str(self.path) + "-wal").exists())

    def test_does_not_observe_uncommitted_write(self):
        self.enqueue(self.queue)
        self.writer.execute("UPDATE projection_thread_prompt_queues SET state_json=?", (json.dumps({**self.queue, "entries": [{"state": "unknown"}]}),))
        self.assertEqual(activity.projection_activity(self.path)["queue"]["entries"], [])

    def test_pending_execution_and_archive_are_independent_signals(self):
        self.writer.execute("INSERT INTO thread_execution_work VALUES('thread','workspace:write',1,'workspace',1,1,0)")
        self.writer.execute("UPDATE projection_threads SET archived_at='2026-10-07'")
        self.writer.commit()
        result = activity.projection_activity(self.path)
        self.assertTrue(result["archived"])
        self.assertTrue(result["unfinished"])

    def test_live_codex_requires_a_settled_session_for_the_current_thread(self):
        self.writer.execute("INSERT INTO projection_thread_sessions VALUES('other','ready','codex',NULL)")
        self.writer.commit()
        self.assertTrue(activity.projection_activity(self.path, codex_only=True)["unfinished"])
        for status, provider, turn, unfinished in (
                ("ready", "codex", None, False),
                ("stopped", "codex", None, True),
                ("running", "codex", None, True),
                ("ready", "claude", None, True),
                ("ready", "codex", "current-turn", True)):
            with self.subTest(status=status, provider=provider, turn=turn):
                self.writer.execute("INSERT OR REPLACE INTO projection_thread_sessions VALUES('thread',?,?,?)", (status, provider, turn))
                self.writer.commit()
                self.assertEqual(activity.projection_activity(self.path, codex_only=True)["unfinished"], unfinished)

    def test_failed_codex_can_be_idle_once_the_turn_and_requests_settle(self):
        self.writer.execute("INSERT INTO projection_thread_sessions VALUES('thread','error','codex',NULL)")
        self.writer.execute("INSERT INTO projection_turns VALUES('thread','2026-11-24','error','ready')")
        for active_turn, approvals, user_inputs, unfinished in (
                ("current-turn", 0, 0, True),
                (None, 1, 0, True),
                (None, 0, 1, True),
                (None, 0, 0, False)):
            with self.subTest(active_turn=active_turn, approvals=approvals, user_inputs=user_inputs):
                self.writer.execute("UPDATE projection_thread_sessions SET active_turn_id=?", (active_turn,))
                self.writer.execute("UPDATE projection_threads SET pending_approval_count=?, pending_user_input_count=?", (approvals, user_inputs))
                self.writer.commit()
                self.assertEqual(activity.projection_activity(self.path, codex_only=True)["unfinished"], unfinished)
        self.writer.execute("UPDATE projection_turns SET checkpoint_status='pending'")
        self.writer.commit()
        self.assertTrue(activity.projection_activity(self.path, codex_only=True)["unfinished"])

    def test_background_receipt_is_current_for_live_codex_and_retained_after_exit(self):
        root = self.path.parent
        file = root / "background.json"
        proc = root / "proc"
        (proc / "42").mkdir(parents=True)
        stat = proc / "42" / "stat"
        stat.write_text("42 (coordinator) " + "S " + "0 " * 18 + "1234")
        live = {"bootId": "boot", "codexOnly": True, "groups": [{"id": "codex"}]}
        stopped = {"bootId": "boot", "groups": []}
        revision = "a" * 32
        current = {"bootId": "boot", "groupId": "codex", "coordinatorPid": 42,
                   "coordinatorStartTicks": "1234", "busy": False, "revision": revision}
        self.assertEqual(activity.background_activity(live, file, proc), {"backgroundBusy": True})
        for updates in ({"bootId": "old"}, {"groupId": "old"}, {"coordinatorStartTicks": "old"}):
            with self.subTest(updates=updates):
                file.write_text(json.dumps({**current, **updates}))
                self.assertEqual(activity.background_activity(live, file, proc), {"backgroundBusy": True})
        file.write_text(json.dumps({**current, "busy": True}))
        self.assertEqual(activity.background_activity(live, file, proc),
                         {"backgroundBusy": True, "backgroundRevision": revision})
        file.write_text(json.dumps(current))
        self.assertEqual(activity.background_activity(live, file, proc),
                         {"backgroundBusy": False, "backgroundRevision": revision})
        stat.unlink()
        self.assertEqual(activity.background_activity(live, file, proc), {"backgroundBusy": True})
        self.assertEqual(activity.background_activity(stopped, file, proc),
                         {"backgroundRevision": revision})
        file.write_text(json.dumps({**current, "busy": True}))
        self.assertEqual(activity.background_activity(stopped, file, proc),
                         {"backgroundRevision": revision + ":stopped"})
        self.assertEqual(activity.background_activity({**stopped, "bootId": "new"}, file, proc), {})

    def test_reports_exact_started_process_reservations_after_a_settled_turn(self):
        for kind in ("provider", "terminal", "setup"):
            self.writer.execute("INSERT INTO thread_execution_work VALUES('thread',?,1,?,1,0,0)", (kind + ":idle", kind))
        self.writer.commit()
        result = activity.projection_activity(self.path)
        self.assertFalse(result["unfinished"])
        self.assertEqual(result["processWorkIds"], ["provider:idle", "setup:idle", "terminal:idle"])
        for work_id, generation, kind, started, completed in (
                ("provider:uncertain", 1, "provider", 0, 0),
                ("provider:old", 0, "provider", 1, 0),
                ("workspace:write", 1, "workspace", 1, 0),
                ("terminal:lost-ack", 1, "terminal", 1, 1)):
            with self.subTest(work_id=work_id):
                self.writer.execute("INSERT INTO thread_execution_work VALUES('thread',?,?,?,?,?,0)", (work_id, generation, kind, started, completed))
                self.writer.commit()
                self.assertTrue(activity.projection_activity(self.path)["unfinished"])
                self.writer.execute("DELETE FROM thread_execution_work WHERE work_id=?", (work_id,))
                self.writer.commit()

    def cancelled_run(self):
        binding = {"jobId": "job", "threadId": "thread", "environmentId": "environment",
                   "generation": 1, "operationId": "enroll", "allocationId": "allocation"}
        run = {"jobId": "job", "executionReserved": False,
               "runtime": {**binding, "kind": "vm", "projectId": "project"},
               "progress": {"status": "cancelled", "threadId": "thread"},
               "providerContinuation": {"driver": "codex", "continuationKey": "secret-continuation"}}
        proof = {**binding, "cancellationId": "cancel", "runtimeEpisode": "secret-episode",
                 "continuationKey": "secret-continuation", "providerInstanceId": "codex",
                 "bootId": "cb7c9212-2128-478f-9d11-6e4c8ed6f882", "epoch": 1}
        payload = {"workflowVmCancellation": proof, "stoppedRuntimeEventsDrained": True,
                   "providerContinuation": {"workflowJobId": "job", "runtimeEpisode": "secret-episode",
                                            "continuationKey": "secret-continuation",
                                            "shutdownConfirmed": True, "shutdownEvidenceVersion": 2}}
        workloads = {"bootId": proof["bootId"], "epoch": 1, "stopped": True, "groups": [],
                     "sealedBy": hashlib.sha256(b"workflow:job:cancel:cancel").hexdigest()[:32]}
        self.writer.executescript("""
            CREATE TABLE repository_workflow_jobs(job_id TEXT,thread_id TEXT,status TEXT,
                execution_reserved INT,record_json TEXT);
            CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,
                status TEXT,runtime_payload_json TEXT);
        """)
        self.writer.execute("INSERT INTO repository_workflow_jobs VALUES('job','thread','cancelled',0,?)", (json.dumps(run),))
        self.writer.execute("INSERT INTO provider_session_runtime VALUES('thread','codex','codex','stopped',?)", (json.dumps(payload),))
        self.writer.commit()
        return workloads, payload

    def test_cancelled_workflow_reports_stopped_without_reopening_the_seal(self):
        workloads, _ = self.cancelled_run()
        self.writer.execute("INSERT INTO thread_execution_work VALUES('thread','terminal:stopped',1,'terminal',1,0,0)")
        self.writer.commit()
        with patch.object(activity, "inspect_workloads", side_effect=[subprocess.CalledProcessError(74, "inspect"), workloads]) as inspect:
            result = activity.read_activity(True, self.path)
        self.assertEqual([call.args for call in inspect.call_args_list], [("workflow-activity-state",), ("inspect",)])
        self.assertEqual(result["workloads"], workloads)
        self.assertTrue(result["projection"]["cancelledStopped"])
        self.assertFalse(result["projection"]["unfinished"])
        self.assertEqual(result["projection"]["processWorkIds"], ["terminal:stopped"])
        self.assertNotIn("secret", json.dumps(result))

        self.writer.execute("INSERT INTO thread_execution_work VALUES('thread','workspace:busy',1,'workspace',1,0,0)")
        self.enqueue({**self.queue, "entries": [{"state": "pending", "text": "secret"}]})
        result = activity.projection_activity(self.path, cancelled_workloads=workloads)
        self.assertTrue(result["unfinished"])
        self.assertEqual(result["queue"]["entries"], [{"state": "pending"}])

    def test_cancelled_seal_covers_only_outstanding_process_reservations_for_current_owner(self):
        workloads, _ = self.cancelled_run()
        process_ids = ["provider:lost-grant", "setup:lost-grant", "terminal:lost-grant"]
        for work_id in process_ids:
            self.writer.execute("INSERT INTO thread_execution_work VALUES('thread',?,1,?,0,0,0)",
                                (work_id, work_id.split(":")[0]))
        self.writer.commit()

        ordinary = activity.projection_activity(self.path)
        self.assertTrue(ordinary["unfinished"])
        self.assertEqual(ordinary["processWorkIds"], [])
        cancelled = activity.projection_activity(self.path, cancelled_workloads=workloads)
        self.assertFalse(cancelled["unfinished"])
        self.assertEqual(cancelled["processWorkIds"], process_ids)

        for work_id, generation, kind, started, completed in (
                ("provider:old", 2, "provider", 0, 0),
                ("workspace:write", 1, "workspace", 0, 0),
                ("terminal:lost-ack", 1, "terminal", 1, 1)):
            with self.subTest(work_id=work_id):
                self.writer.execute("INSERT INTO thread_execution_work VALUES('thread',?,?,?,?,?,0)",
                                    (work_id, generation, kind, started, completed))
                self.writer.commit()
                cancelled = activity.projection_activity(self.path, cancelled_workloads=workloads)
                self.assertTrue(cancelled["unfinished"])
                self.assertEqual(cancelled["processWorkIds"], process_ids)
                self.writer.execute("DELETE FROM thread_execution_work WHERE work_id=?", (work_id,))
                self.writer.commit()

    def test_sealed_activity_rejects_busy_changed_or_unconfirmed_cancellation(self):
        workloads, payload = self.cancelled_run()
        for updates in ({"sealedBy": "unrelated"}, {"sealedBy": None}, {"epoch": 2},
                        {"bootId": "another-boot"}, {"stopped": False}, {"groups": [{}]}):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                activity.projection_activity(self.path, cancelled_workloads={**workloads, **updates})
        for updated_payload in (
                {**payload, "stoppedRuntimeEventsDrained": False},
                {**payload, "workflowVmCancellation": {**payload["workflowVmCancellation"], "allocationId": "other"}},
                {**payload, "workflowVmCancellation": {**payload["workflowVmCancellation"], "operationId": "old"}},
                {**payload, "providerContinuation": {**payload["providerContinuation"], "runtimeEpisode": "old"}}):
            self.writer.execute("UPDATE provider_session_runtime SET runtime_payload_json=?", (json.dumps(updated_payload),))
            self.writer.commit()
            with self.assertRaises(ValueError):
                activity.projection_activity(self.path, cancelled_workloads=workloads)

    def test_missing_database_is_not_created_and_ambiguous_owner_is_rejected(self):
        missing = self.path.with_name("missing.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            activity.projection_activity(missing)
        self.assertFalse(missing.exists())
        self.writer.execute("INSERT INTO thread_execution_fences VALUES('foreign','foreign',1,'active','foreign','enroll')")
        self.writer.commit()
        with self.assertRaises(ValueError):
            activity.projection_activity(self.path)

    def test_malformed_queue_is_not_reported_idle(self):
        for invalid in [{}, {**self.queue, "enabled": 1}, {**self.queue, "entries": [{"kind": "future", "state": "pending"}]}, {**self.queue, "entries": [{"kind": "move", "state": "delivering"}]}]:
            with self.subTest(invalid=invalid):
                self.enqueue(invalid)
                with self.assertRaises(ValueError):
                    activity.projection_activity(self.path)


if __name__ == "__main__":
    unittest.main()
