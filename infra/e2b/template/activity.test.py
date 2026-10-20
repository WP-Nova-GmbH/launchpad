import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("activity", Path(__file__).with_name("activity.py"))
activity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activity)


class DurableActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="launchpad-activity-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.sqlite"
        self.writer = sqlite3.connect(self.path)
        self.addCleanup(self.writer.close)
        self.writer.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE thread_execution_fences(thread_id TEXT,environment_id TEXT,generation INT,phase TEXT);
            CREATE TABLE projection_threads(thread_id TEXT,archived_at TEXT,deleted_at TEXT);
            CREATE TABLE projection_thread_prompt_queues(thread_id TEXT,state_json TEXT);
            CREATE TABLE projection_turns(thread_id TEXT,completed_at TEXT,state TEXT,checkpoint_status TEXT);
            CREATE TABLE thread_execution_work(thread_id TEXT,work_id TEXT,generation INT,kind TEXT,started INT,completed INT,relay_completed INT);
            INSERT INTO thread_execution_fences VALUES('thread','environment',1,'active');
            INSERT INTO projection_threads VALUES('thread',NULL,NULL);
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

    def test_missing_database_is_not_created_and_ambiguous_owner_is_rejected(self):
        missing = self.path.with_name("missing.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            activity.projection_activity(missing)
        self.assertFalse(missing.exists())
        self.writer.execute("INSERT INTO thread_execution_fences VALUES('foreign','foreign',1,'active')")
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
