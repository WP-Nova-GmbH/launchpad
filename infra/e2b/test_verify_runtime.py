import hashlib
import io
import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


runtime = runpy.run_path(
    str(Path(__file__).with_name('verify-runtime.py'))
)
verify_configuration = runtime['verify_configuration']


class VerifyRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / '.env').write_text('HOST_SECRET=must-not-print\n')
        (self.root / 'compose.yaml').write_text('reviewed Compose baseline')
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

    def invoke_verifier(self, *, exclusive=True):
        command = ['verify-runtime.py', '--build-directory', str(self.root),
                   '--project-directory', str(self.root)]
        for name in ('compose.yaml', 'runtime.override.json', 'compose.override.yaml'):
            command += ['--file', str(self.root / name)]
        if exclusive:
            command += ['--require-exclusive-host']
        with mock.patch.object(sys, 'argv', command), redirect_stdout(io.StringIO()):
            runtime['main']()

    def test_exclusive_preflight_requires_the_existing_deployment_before_docker(self):
        for name in ('.env', 'build.json', 'compose.yaml', 'runtime.override.json', 'compose.override.yaml'):
            with self.subTest(missing=name):
                file = self.root / name
                original = file.read_bytes()
                file.unlink()
                with mock.patch.object(subprocess, 'run') as run:
                    with self.assertRaisesRegex(SystemExit, 'Selected VM host runtime is incomplete'):
                        self.invoke_verifier()
                    run.assert_not_called()
                file.write_bytes(original)

    def test_default_verification_does_not_inspect_other_containers(self):
        with mock.patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, json.dumps(self.config))) as run:
            self.invoke_verifier(exclusive=False)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][-3:], ['config', '--format', 'json'])

    def test_exclusive_preflight_refuses_another_running_e2b_project_without_leaking_secrets(self):
        container = {'State': {'Running': True}, 'Config': {
            'Labels': {'com.docker.compose.service': 'orchestrator',
                       'com.docker.compose.project': 'another-e2b-deployment'},
            'Env': ['OL_COMMAND=private-launcher-command', 'HOST_SECRET=must-not-print'],
        }}
        with mock.patch.object(subprocess, 'run', side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps(self.config)),
            subprocess.CompletedProcess([], 0, 'abcdef012345\n'),
            subprocess.CompletedProcess([], 0, json.dumps([container])),
        ]) as run:
            with self.assertRaisesRegex(SystemExit, 'Another E2B deployment') as error:
                self.invoke_verifier()
            self.assertNotIn('must-not-print', str(error.exception))
            self.assertNotIn('private-launcher-command', str(error.exception))
            self.assertEqual(run.call_count, 3)
            self.assertEqual(run.call_args.args[0], ['docker', 'inspect', 'abcdef012345'])

    def test_exclusive_preflight_allows_its_own_project_and_ignores_unrelated_or_stopped_containers(self):
        def container(project, environment, *, running=True, service='orchestrator', command=None):
            return {'State': {'Running': running}, 'Config': {
                'Labels': {'com.docker.compose.service': service,
                           'com.docker.compose.project': project}, 'Env': environment, 'Cmd': command,
            }}
        upstream = ['/bin/bash', '/opt/e2b/scripts/orchestrator-launch.sh']
        containers = [
            container('launchpad-e2b-proof-test', ['OL_COMMAND=launcher']),
            container('launchpad-e2b-proof-test', [], command=upstream),
            container('unrelated-project', ['HOST_SECRET=must-not-print']),
            container('unrelated-shell-app', [], command=['/bin/bash', '/app/orchestrator-launch.sh']),
            container('stopped-e2b', ['OL_COMMAND=launcher'], running=False),
            container('stopped-upstream-e2b', [], running=False, command=upstream),
            container('another-service', ['OL_COMMAND=launcher'], service='worker'),
            container('another-service', [], service='worker', command=upstream),
        ]
        with mock.patch.object(subprocess, 'run', side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps(self.config)),
            subprocess.CompletedProcess([], 0, 'abcdef012345\n'),
            subprocess.CompletedProcess([], 0, json.dumps(containers)),
        ]):
            self.invoke_verifier()

    def test_exclusive_preflight_refuses_the_unmodified_upstream_e2b_launcher(self):
        container = {'State': {'Running': True}, 'Config': {
            'Labels': {'com.docker.compose.service': 'orchestrator',
                       'com.docker.compose.project': 'upstream-e2b'},
            'Env': ['NODE_ID=orchestrator'],
            'Cmd': ['/bin/bash', '/opt/e2b/scripts/orchestrator-launch.sh'],
        }}
        with mock.patch.object(subprocess, 'run', side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps(self.config)),
            subprocess.CompletedProcess([], 0, 'abcdef012345\n'),
            subprocess.CompletedProcess([], 0, json.dumps([container])),
        ]):
            with self.assertRaisesRegex(SystemExit, 'Another E2B deployment'):
                self.invoke_verifier()

    def test_exclusive_preflight_docker_failures_are_secret_safe(self):
        cases = [
            [subprocess.CompletedProcess([], 1, 'HOST_SECRET=must-not-print')],
            [subprocess.CompletedProcess([], 0, 'abcdef012345\n'),
             subprocess.CompletedProcess([], 1, 'HOST_SECRET=must-not-print')],
            [subprocess.CompletedProcess([], 0, 'abcdef012345\n'),
             subprocess.CompletedProcess([], 0, 'HOST_SECRET=must-not-print')],
        ]
        for replies in cases:
            with self.subTest(replies=len(replies)), mock.patch.object(subprocess, 'run', side_effect=replies):
                with self.assertRaises(RuntimeError) as error:
                    runtime['verify_exclusive_host']('launchpad-e2b-proof-test')
                self.assertNotIn('must-not-print', str(error.exception))

    def test_exclusive_preflight_does_not_inspect_when_no_orchestrators_are_running(self):
        with mock.patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '')) as run:
            runtime['verify_exclusive_host']('launchpad-e2b-proof-test')
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
