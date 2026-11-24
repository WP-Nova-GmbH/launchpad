import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "checkpoint_reader", Path(__file__).with_name("workflow-checkpoint-reader.py")
)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
NATIVE_ID = "2e9a9608-3f3f-46a2-89e1-43dd8aea348c"


class ConversationFileTest(unittest.TestCase):
    def test_lists_only_owned_native_history_and_refuses_links_or_other_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            active = home / "sessions" / "2026" / "11" / "24"
            archived = home / "archived_sessions"
            native_files = home / "native-files"
            for folder in (active, archived, native_files):
                folder.mkdir(parents=True)
            current = active / "rollout-current.jsonl"
            past = archived / "rollout-past.jsonl"
            for file in (current, past):
                file.write_text(json.dumps({"type": "session_meta", "payload": {"id": NATIVE_ID}}))
            (active / "rollout-other.jsonl").write_text(json.dumps({
                "type": "session_meta", "payload": {"session_id": "unrelated"},
            }))
            (native_files / "proof.txt").write_text("test file")
            (home / "auth.json").write_text("fixture")
            fd = os.open(home, reader.DIRECTORY_FLAGS)
            try:
                self.assertEqual(reader.list_conversation_files(fd, os.getuid(), NATIVE_ID), [
                    "archived_sessions/rollout-past.jsonl",
                    "native-files/proof.txt",
                    "sessions/2026/11/24/rollout-current.jsonl",
                ])
                (native_files / "link").symlink_to(home / "auth.json")
                with self.assertRaisesRegex(ValueError, "symlink"):
                    reader.list_conversation_files(fd, os.getuid(), NATIVE_ID)
            finally:
                os.close(fd)
        with mock.patch.object(reader, "CODEX_HOME", "/different/home"):
            with self.assertRaisesRegex(ValueError, "Invalid native conversation lookup"):
                reader.main("conversation-files", io.BytesIO(NATIVE_ID.encode()), io.BytesIO())


if __name__ == "__main__":
    unittest.main()
