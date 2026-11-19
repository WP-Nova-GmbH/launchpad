import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

PROOF = Path(__file__).with_name("verify-network-proof.py").resolve()


class NetworkProofInputsTests(unittest.TestCase):
    def test_mutable_or_invalid_sdk_image_never_reaches_host_operations(self):
        with tempfile.TemporaryDirectory() as scratch:
            output = Path(scratch) / "evidence"
            for image in ("latest", "helper:latest", "sha256:bad", "sha256:" + "G" * 64,
                          "helper@sha256:" + "a" * 64):
                with self.subTest(image=image):
                    result = subprocess.run([sys.executable, "-I", "-B", str(PROOF), "--sdk-image", image,
                                             "--seed-volume", "test-only", "--output", str(output)],
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("immutable local sha256 image ID", result.stderr)
                    self.assertFalse(output.exists())

    @unittest.skipUnless(shutil.which("node"), "Node is required for the SDK version preflight")
    def test_wrong_sdk_version_fails_before_reading_credentials_or_creating_guests(self):
        with tempfile.TemporaryDirectory() as scratch:
            app = Path(scratch)
            sdk = app / "node_modules/e2b"
            sdk.mkdir(parents=True)
            (app / "probe.mjs").write_bytes(PROOF.with_name("network-proof.mjs").read_bytes())
            (sdk / "package.json").write_text('{"type":"module","main":"index.mjs","version":"2.46.1"}')
            (sdk / "index.mjs").write_text('export class Sandbox {static create(){throw Error("must not create a guest")}}; export class SandboxNotFoundError extends Error{};')
            result = subprocess.run(["node", str(app / "probe.mjs")], capture_output=True, text=True,
                                    env={key: value for key, value in os.environ.items()
                                         if not key.startswith("LAUNCHPAD_PROOF_")})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Network proof requires the unmodified stock runtime E2B 2.61.0 helper", result.stderr)
            self.assertNotIn("ENOENT", result.stderr)
            self.assertNotIn("must not create a guest", result.stderr)


if __name__ == "__main__":
    unittest.main()
