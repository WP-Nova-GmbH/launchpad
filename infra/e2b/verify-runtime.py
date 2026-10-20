#!/usr/bin/env python3
"""Verify resolved Compose pins against a build receipt before starting E2B."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def verify_configuration(build_directory, configuration, project_name=None, *, keeper_script=None):
    build_directory = Path(build_directory).resolve()
    receipt = json.loads((build_directory / 'build.json').read_text())
    if configuration.get('name') != (project_name or receipt['composeProject']):
        raise ValueError('Compose project differs from the selected deployment')
    expected = json.loads((build_directory / 'runtime.override.json').read_text())
    services = configuration['services']
    for name in ('api', 'client-proxy', 'db-migrator'):
        if services[name].get('image') != receipt['images'][name]['id']:
            raise ValueError(f'{name} image differs from the selected build receipt')
    # A later Compose file can silently replace this host launcher while keeping
    # the API image current. Compare the fully merged configuration.
    command = expected['services']['orchestrator']['environment']['OL_COMMAND'].replace('$$', '$')
    if services['orchestrator'].get('environment', {}).get('OL_COMMAND') != command:
        raise ValueError('orchestrator launcher differs from the selected build')
    for flag in ('LAUNCHPAD_REQUIRE_HOST_FIREWALL', 'LAUNCHPAD_REQUIRE_EXECUTION_FENCE', 'BUILD_ENSURE_FREE_DISK_SPACE'):
        if str(services['orchestrator'].get('environment', {}).get(flag, '')).lower() != 'true':
            raise ValueError(f'{flag} must be enabled in the resolved configuration')
    lock = json.loads((build_directory / 'runtime.lock.json').read_text())
    keeper_image = lock['embed']['images']['node-e2b']
    keeper = services.get('launchpad-keepalive', {})
    if keeper.get('image') != f"{keeper_image['tag']}@{keeper_image['digest']}":
        raise ValueError('host keeper is missing or does not use the pinned SDK image')
    if keeper.get('network_mode') != 'host' or keeper.get('restart') != 'unless-stopped':
        raise ValueError('host keeper must run with the E2B API on the compute host')
    if keeper.get('entrypoint') != ['node', '/app/launchpad-keepalive.ts']:
        raise ValueError('host keeper entrypoint differs from the reviewed script')
    if keeper.get('environment', {}).get('E2B_API_URL') != 'http://127.0.0.1:3000':
        raise ValueError('host keeper must use the compute-host API')
    mounts = keeper.get('volumes', [])
    def mounted(target, source=None):
        return any(mount.get('type') == ('bind' if source else 'volume')
                   and mount.get('target') == target and mount.get('read_only') is True
                   and (source is None or Path(mount.get('source', '')).resolve() == source)
                   for mount in mounts)
    installed_keeper = Path(keeper_script or build_directory / 'e2b-keepalive.ts').resolve()
    if not mounted('/run/e2b') or not mounted('/app/launchpad-keepalive.ts', installed_keeper):
        raise ValueError('host keeper needs read-only key and reviewed script mounts')
    if hashlib.sha256(installed_keeper.read_bytes()).hexdigest() != receipt['keeperSha256']:
        raise ValueError('installed keeper script differs from its build checksum')
    for file, checksum in (('compose.override.yaml', 'composeOverrideSha256'),
                           ('e2b-keepalive.ts', 'keeperSha256')):
        digest = hashlib.sha256((build_directory / file).read_bytes()).hexdigest()
        if digest != receipt[checksum]:
            raise ValueError(f'{file} differs from its build checksum')
    artifact = build_directory / 'artifacts/orchestrator'
    digest = hashlib.sha256()
    with artifact.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != receipt['orchestratorSha256']:
        raise ValueError('orchestrator binary differs from its build checksum')
    environment = services['orchestrator'].get('environment', {})
    expected_probe = expected['services']['orchestrator']['environment'].get('RESTORE_COLD_PROBE_SCRIPT')
    probe_files = receipt.get('coldProbeSha256')
    if expected_probe or probe_files:
        required = {'quarantine-probe.py', 'runtime.lock.json', 'quarantine/init_linux.go',
                    'build/init', 'build/init_linux.go', 'build/build.json'}
        if not isinstance(probe_files, dict) or set(probe_files) != required:
            raise ValueError('cold probe build receipt is incomplete')
        for key in ('RESTORE_COLD_PROBE_SCRIPT', 'RESTORE_COLD_PROBE_BUILD'):
            if environment.get(key) != expected['services']['orchestrator']['environment'].get(key, '').replace('$$', '$'):
                raise ValueError('cold probe paths differ from the selected build')
        for name in required:
            artifact = build_directory / 'artifacts/launchpad-probe' / name
            digest = hashlib.sha256()
            with artifact.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            if digest.hexdigest() != probe_files[name]:
                raise ValueError('cold probe artifact differs from its build checksum')
    elif str(environment.get('RESTORE_COLD_PROBE_ENABLED', '')).lower() == 'true':
        raise ValueError('cold probe enabled without a verified build')
    if 'build-collector' in receipt['images']:
        artifact = build_directory / 'artifacts/launchpad-build-collector'
        digest = hashlib.sha256()
        with artifact.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != receipt['buildCollectorSha256']:
            raise ValueError('build collector differs from its build checksum')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-directory', type=Path, required=True)
    parser.add_argument('--project-directory', type=Path, required=True)
    parser.add_argument('--project-name', help='Existing Compose project to upgrade; use the same name when starting services')
    parser.add_argument('--keeper-script', type=Path,
                        help='Preserve this installed keeper path; its content must match the selected build receipt')
    parser.add_argument('--file', action='append', type=Path, required=True,
                        help='Every Compose file, in the same order used to start services')
    args = parser.parse_args()
    command = ['docker', 'compose', '--project-directory', str(args.project_directory.resolve())]
    if args.project_name:
        command += ['--project-name', args.project_name]
    for file in args.file:
        command += ['--file', str(file.resolve())]
    # The resolved document may contain installation secrets; never print it.
    result = subprocess.run(command + ['config', '--format', 'json'], capture_output=True, check=False)
    if result.returncode:
        raise SystemExit('Compose configuration failed; inspect the installation locally.')
    try:
        verify_configuration(args.build_directory, json.loads(result.stdout), args.project_name,
                             keeper_script=args.keeper_script)
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(f'Runtime verification failed: {type(error).__name__}. Check the build receipt, binary and Compose override order.') from None
    print('Runtime image pins and orchestrator launcher match the selected build receipt.')


if __name__ == '__main__':
    main()
