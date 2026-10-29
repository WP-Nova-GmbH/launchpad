import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("collector_builder", Path(__file__).with_name("build-snapshot-collector.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class CollectorBuildTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.module = self.root / "module"
        self.module.mkdir()
        (self.module / "go.mod").write_text("require github.com/e2b-dev/infra/packages/shared v0.0.0-20261027102042-518278060a15\n")
        (self.module / "go.sum").write_text("pinned checksums\n")
        self.output = self.root / "artifact"

    def test_failed_build_never_publishes_an_artifact(self):
        with patch.object(builder.subprocess, "run", side_effect=RuntimeError("compile failed")):
            with self.assertRaises(RuntimeError):
                builder.build(self.output, "arm64", self.module)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_name("artifact.json").exists())

    def test_successful_build_has_a_matching_receipt_and_refuses_overwrite(self):
        def compile_artifact(args, **kwargs):
            Path(args[args.index("-o") + 1]).write_bytes(b"disposable ELF fixture")
        with patch.object(builder.subprocess, "run", side_effect=compile_artifact):
            builder.build(self.output, "arm64", self.module)
            with self.assertRaises(ValueError):
                builder.build(self.output, "arm64", self.module)
        receipt = json.loads(self.output.with_name("artifact.json").read_text())
        self.assertEqual(receipt["binarySha256"], hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(receipt["target"], "linux/arm64")
        self.assertEqual(self.output.read_bytes(), b"disposable ELF fixture")


if __name__ == "__main__":
    unittest.main()
