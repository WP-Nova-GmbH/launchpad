#!/usr/bin/env python3
"""Apply/check the dedicated Launchpad E2B host's required guest firewall."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

POLICY = Path('/etc/launchpad/host-firewall.nft')
RECEIPT = Path('/run/launchpad-thread-vm/firewall.json')


def rules_fingerprint(document):
    """Ignore changing counters/handles, retain every rule and its order."""
    def normalize(value):
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {key: ({} if key == 'counter' and isinstance(item, dict) else normalize(item))
                    for key, item in value.items() if key != 'handle'}
        return value
    entries = document.get('nftables')
    if not isinstance(entries, list):
        raise ValueError('nftables did not return its rule list')
    entries = [item for item in entries if 'metainfo' not in item]
    if not any(item.get('table', {}).get('name') == 'launchpad_thread_vm' and
               item.get('table', {}).get('family') == 'inet' for item in entries):
        raise ValueError('required firewall table is absent')
    return hashlib.sha256(json.dumps(normalize(entries), sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def active_fingerprint():
    raw = subprocess.check_output(['nft', '--json', 'list', 'table', 'inet',
                                   'launchpad_thread_vm'], timeout=2)
    return rules_fingerprint(json.loads(raw))


def policy_fingerprint():
    # The host administrator owns this policy; guests cannot modify it or the
    # receipt. Refuse accidental group/world-writable installations.
    info = POLICY.stat(follow_symlinks=False)
    if not POLICY.is_file() or POLICY.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('firewall policy must be a root-owned regular file')
    return hashlib.sha256(POLICY.read_bytes()).hexdigest()


def main(action):
    policy = policy_fingerprint()
    if action == 'apply':
        subprocess.run(['nft', '--check', '--file', str(POLICY)], check=True, timeout=5)
        subprocess.run(['nft', '--file', str(POLICY)], check=True, timeout=5)
        record = {'version': 1, 'policy': policy, 'rules': active_fingerprint()}
        RECEIPT.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = RECEIPT.with_suffix('.tmp')
        with temporary.open('w') as file:
            os.chmod(temporary, 0o600)
            json.dump(record, file)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(RECEIPT)
    elif action == 'check':
        record = json.loads(RECEIPT.read_text())
        if record != {'version': 1, 'policy': policy, 'rules': active_fingerprint()}:
            raise ValueError('active guest firewall differs from the installed policy')
    else:
        raise ValueError('usage: launchpad-host-firewall apply|check')


if __name__ == '__main__':
    try:
        main(sys.argv[1] if len(sys.argv) == 2 else '')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Launchpad host firewall is not ready: {error}', file=sys.stderr)
        sys.exit(1)
