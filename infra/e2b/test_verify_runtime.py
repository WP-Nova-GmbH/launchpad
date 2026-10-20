import hashlib
import json
import runpy
import tempfile
import unittest
from pathlib import Path


verify_configuration = runpy.run_path(
    str(Path(__file__).with_name('verify-runtime.py'))
)['verify_configuration']


class VerifyRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'artifacts').mkdir()
        (self.root / 'artifacts/orchestrator').write_bytes(b'host binary')
        (self.root / 'compose.override.yaml').write_text('reviewed override')
        (self.root / 'e2b-keepalive.ts').write_text('reviewed keeper')
        self.keeper_image = 'example.com/node-e2b:test@sha256:verified'
        (self.root / 'runtime.lock.json').write_text(json.dumps({
            'embed': {'images': {'node-e2b': {
                'tag': 'example.com/node-e2b:test', 'digest': 'sha256:verified',
            }}},
        }))
        (self.root / 'build.json').write_text(json.dumps({
            'composeProject': 'launchpad-e2b-proof-test',
            'images': {name: {'id': f'sha256:{name}'}
                       for name in ('api', 'client-proxy', 'db-migrator')},
            'orchestratorSha256': hashlib.sha256(b'host binary').hexdigest(),
            'composeOverrideSha256': hashlib.sha256(b'reviewed override').hexdigest(),
            'keeperSha256': hashlib.sha256(b'reviewed keeper').hexdigest(),
        }))
        (self.root / 'runtime.override.json').write_text(json.dumps({
            'services': {'orchestrator': {'environment': {'OL_COMMAND': 'host launcher'}}},
        }))
        self.config = {'name': 'launchpad-e2b-proof-test', 'services': {
            **{name: {'image': f'sha256:{name}'}
               for name in ('api', 'client-proxy', 'db-migrator')},
            'orchestrator': {'environment': {
                'OL_COMMAND': 'host launcher',
                'LAUNCHPAD_REQUIRE_HOST_FIREWALL': 'true',
                'LAUNCHPAD_REQUIRE_EXECUTION_FENCE': 'true',
                'BUILD_ENSURE_FREE_DISK_SPACE': 'true',
            }},
            'launchpad-keepalive': {
                'image': self.keeper_image,
                'network_mode': 'host',
                'restart': 'unless-stopped',
                'entrypoint': ['node', '/app/launchpad-keepalive.ts'],
                'environment': {'E2B_API_URL': 'http://127.0.0.1:3000'},
                'volumes': [
                    {'type': 'volume', 'source': 'seed-state', 'target': '/run/e2b',
                     'read_only': True},
                    {'type': 'bind', 'source': str(self.root / 'e2b-keepalive.ts'),
                     'target': '/app/launchpad-keepalive.ts', 'read_only': True},
                ],
            },
        }}

    def test_rejects_another_project_even_when_runtime_pins_match(self):
        self.config['name'] = 'launchpad-e2b-proof-another-build'
        with self.assertRaisesRegex(ValueError, 'Compose project differs'):
            verify_configuration(self.root, self.config)

    def test_upgrade_requires_the_explicit_existing_project(self):
        self.config['name'] = 'launchpad-existing-deployment'
        verify_configuration(self.root, self.config, 'launchpad-existing-deployment')
        with self.assertRaisesRegex(ValueError, 'Compose project differs'):
            verify_configuration(self.root, self.config, 'launchpad-wrong-deployment')

    def test_requires_verified_host_keeper(self):
        verify_configuration(self.root, self.config)
        del self.config['services']['launchpad-keepalive']
        with self.assertRaisesRegex(ValueError, 'host keeper is missing'):
            verify_configuration(self.root, self.config)

    def test_rejects_writable_or_wrong_keeper_script(self):
        keeper = self.config['services']['launchpad-keepalive']
        keeper['volumes'][1]['read_only'] = False
        with self.assertRaisesRegex(ValueError, 'read-only'):
            verify_configuration(self.root, self.config)
        keeper['volumes'][1]['read_only'] = True
        (self.root / 'e2b-keepalive.ts').write_text('unexpected edit')
        with self.assertRaisesRegex(ValueError, 'build checksum'):
            verify_configuration(self.root, self.config)

    def test_preserves_an_explicit_unchanged_installed_keeper(self):
        installed = self.root / 'inherited' / 'e2b-keepalive.ts'
        installed.parent.mkdir()
        installed.write_text('reviewed keeper')
        self.config['services']['launchpad-keepalive']['volumes'][1]['source'] = str(installed)
        with self.assertRaisesRegex(ValueError, 'read-only'):
            verify_configuration(self.root, self.config)
        verify_configuration(self.root, self.config, keeper_script=installed)

    def test_explicit_keeper_still_requires_selected_path_and_build_checksum(self):
        installed = self.root / 'inherited' / 'e2b-keepalive.ts'
        installed.parent.mkdir()
        installed.write_text('reviewed keeper')
        with self.assertRaisesRegex(ValueError, 'read-only'):
            verify_configuration(self.root, self.config, keeper_script=installed)
        self.config['services']['launchpad-keepalive']['volumes'][1]['source'] = str(installed)
        installed.write_text('unexpected edit')
        with self.assertRaisesRegex(ValueError, 'build checksum'):
            verify_configuration(self.root, self.config, keeper_script=installed)

    def test_rejects_changed_build_collector(self):
        artifact = self.root / 'artifacts/launchpad-build-collector'
        artifact.write_bytes(b'reviewed collector')
        receipt_path = self.root / 'build.json'
        receipt = json.loads(receipt_path.read_text())
        receipt['images']['build-collector'] = {'id': 'sha256:collector'}
        receipt['buildCollectorSha256'] = hashlib.sha256(b'reviewed collector').hexdigest()
        receipt_path.write_text(json.dumps(receipt))
        verify_configuration(self.root, self.config)
        artifact.write_bytes(b'unexpected collector')
        with self.assertRaisesRegex(ValueError, 'build collector differs'):
            verify_configuration(self.root, self.config)


    def install_probe(self):
        files = ['quarantine-probe.py', 'runtime.lock.json', 'quarantine/init_linux.go',
                 'build/init', 'build/init_linux.go', 'build/build.json']
        digests = {}
        for name in files:
            artifact = self.root / 'artifacts/launchpad-probe' / name
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_bytes(('reviewed ' + name).encode())
            digests[name] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        receipt = json.loads((self.root / 'build.json').read_text())
        receipt['coldProbeSha256'] = digests
        (self.root / 'build.json').write_text(json.dumps(receipt))
        expected = json.loads((self.root / 'runtime.override.json').read_text())
        paths = {'RESTORE_COLD_PROBE_SCRIPT': str(self.root / 'artifacts/launchpad-probe/quarantine-probe.py'),
                 'RESTORE_COLD_PROBE_BUILD': str(self.root / 'artifacts/launchpad-probe/build')}
        expected['services']['orchestrator']['environment'].update(paths)
        (self.root / 'runtime.override.json').write_text(json.dumps(expected))
        self.config['services']['orchestrator']['environment'].update(paths)
        self.config['services']['orchestrator']['environment']['RESTORE_COLD_PROBE_ENABLED'] = 'true'
        return files

    def test_rejects_changed_probe_boot_assets(self):
        files = self.install_probe()
        verify_configuration(self.root, self.config)
        for name in files:
            with self.subTest(artifact=name):
                artifact = self.root / 'artifacts/launchpad-probe' / name
                original = artifact.read_bytes()
                artifact.write_bytes(b'unexpected code or boot asset')
                with self.assertRaisesRegex(ValueError, 'cold probe artifact differs'):
                    verify_configuration(self.root, self.config)
                artifact.write_bytes(original)

    def test_later_compose_cannot_replace_probe_paths(self):
        self.install_probe()
        env = self.config['services']['orchestrator']['environment']
        for key in ['RESTORE_COLD_PROBE_SCRIPT', 'RESTORE_COLD_PROBE_BUILD']:
            with self.subTest(path=key):
                original = env[key]
                env[key] = '/another-build/probe'
                with self.assertRaisesRegex(ValueError, 'cold probe paths differ'):
                    verify_configuration(self.root, self.config)
                env[key] = original

    def test_enabled_probe_requires_complete_build_receipt(self):
        self.config['services']['orchestrator']['environment']['RESTORE_COLD_PROBE_ENABLED'] = 'true'
        with self.assertRaisesRegex(ValueError, 'without a verified build'):
            verify_configuration(self.root, self.config)
        self.install_probe()
        receipt = json.loads((self.root / 'build.json').read_text())
        del receipt['coldProbeSha256']['build/init']
        (self.root / 'build.json').write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, 'receipt is incomplete'):
            verify_configuration(self.root, self.config)


if __name__ == '__main__':
    unittest.main()
