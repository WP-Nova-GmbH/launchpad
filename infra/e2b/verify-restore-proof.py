#!/usr/bin/env python3
"""Verify a disposable prepared-restore test canary before releasing its boot gate."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('prepared_directory',type=Path)
p.add_argument('gate_directory',type=Path)
a=p.parse_args()
ready=json.loads((a.gate_directory/'prepared.json').read_text())
build=str(uuid.UUID(ready['preparedBuildID']))
operation=str(uuid.UUID(ready['operationID']))
disk=a.prepared_directory/build/'rootfs.ext4'
assert disk.is_file(), 'The prepared disk must already exist'
# Parse only the test disk, in a private filesystem with no network or host
# state. Root can read the 0600 image but has no capabilities or writable binds.
args=['systemd-run','--wait','--pipe','--collect','--quiet','--unit=launchpad-restore-proof-'+operation,
 '--property=RuntimeMaxSec=30','--property=User=root','--property=CapabilityBoundingSet=',
 '--property=NoNewPrivileges=yes','--property=PrivateNetwork=yes','--property=PrivateDevices=yes',
 '--property=PrivateIPC=yes','--property=RestrictNamespaces=yes','--property=ProtectHome=yes',
 '--property=SystemCallFilter=@system-service','--property=SystemCallFilter=~@privileged @resources',
 '--property=TemporaryFileSystem=/', '--property=BindReadOnlyPaths=/usr',
 '--property=BindReadOnlyPaths=/usr/lib:/lib','--property=BindReadOnlyPaths=-/usr/lib64:/lib64',
 '--property=BindReadOnlyPaths='+str(disk)+':/proof.ext4']
def inspect(command):
 return subprocess.check_output([*args,'--','/usr/sbin/debugfs','-R',command,'/proof.ext4'],stderr=subprocess.STDOUT,text=True)
assert 'preserved dirty content' in inspect('cat /home/user/launchpad-dirty'), 'Prepared disk fixture is missing'
assert 'File not found by ext2_lookup' in inspect('stat /home/user/launchpad-startup-canary'), 'Saved startup code ran before activation'
assert 'Type: regular' in inspect('stat /etc/systemd/system/launchpad-startup.service'), 'Saved startup program was removed'
assert 'Type: symlink' in inspect('stat /etc/systemd/system/multi-user.target.wants/launchpad-startup.service'), 'Saved startup program was disabled'
receipt={'operationID':operation,'preparedBuildID':build,'startupAbsent':True,'startupStillEnabled':True}
(a.gate_directory/'verified.json').write_text(json.dumps(receipt)+'\n')
print(json.dumps(receipt))
