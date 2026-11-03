import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "workflow_model_proof", Path(__file__).with_name("workflow-model-proof.py")
)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class GuestModelProofTests(unittest.TestCase):
    def test_uses_packaged_policy_and_drops_models_the_guest_does_not_allow(self):
        policy = {
            "schemaVersion": 1,
            "defaultModel": "guest-default",
            "modelSlugs": ["guest-default", "guest-extra"],
            "probeArgs": ["app-server", "--guest-policy"],
        }
        codex_models = [
            {"slug": "gpt-6-astra", "name": "Checkout default"},
            {"slug": "guest-extra", "name": "Extra guest model"},
            {"slug": "guest-default", "name": "Guest default"},
        ]
        with (
            mock.patch.object(proof.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(policy),
            )) as command,
            mock.patch.object(proof, "probe", return_value=codex_models) as probe,
        ):
            catalog = proof.guest_catalog("/guest/t3", "/guest/codex")
        self.assertEqual(catalog, {
            "defaultModel": "guest-default",
            "models": codex_models[1:],
        })
        self.assertEqual(command.call_args.args[0], ["/guest/t3", "__thread-vm-codex-model-policy"])
        self.assertEqual(set(command.call_args.kwargs["env"]), {"HOME", "CODEX_HOME", "PATH"})
        probe.assert_called_once_with("/guest/codex", policy["probeArgs"])

    def test_old_guest_requests_rebuild_before_invoking_codex(self):
        with (
            mock.patch.object(proof.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 1, stderr="unknown command",
            )),
            mock.patch.object(proof, "probe") as probe,
        ):
            with self.assertRaisesRegex(proof.ModelPolicyUnavailable, "Rebuild the selected VM runner"):
                proof.guest_catalog("/guest/t3", "/guest/codex")
        probe.assert_not_called()

    def test_rejects_a_codex_catalog_missing_the_packaged_default(self):
        with (
            mock.patch.object(proof, "read_policy", return_value={
                "defaultModel": "guest-default",
                "modelSlugs": ["guest-default", "guest-extra"],
                "probeArgs": ["app-server"],
            }),
            mock.patch.object(proof, "probe", return_value=[
                {"slug": "guest-extra", "name": "Extra guest model"},
            ]),
        ):
            with self.assertRaisesRegex(RuntimeError, "did not report the packaged VM server's default"):
                proof.guest_catalog("/guest/t3", "/guest/codex")
