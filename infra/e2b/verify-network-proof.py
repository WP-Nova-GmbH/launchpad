#!/usr/bin/env python3
"""Run only on the dedicated E2B Linux host with its host firewall enabled.

The synthetic public IP is assigned to loopback for this proof; no packets are
sent to its Internet owner. Only captured listener/container identities and VMs
with the unique proof metadata are stopped. E2B pools network namespaces, so
namespace routes, addresses, and forwarding state must also be restored.
"""

from pathlib import Path
import subprocess, json, time, os, socket, ipaddress, argparse, uuid
from urllib.parse import urlparse
parser = argparse.ArgumentParser(description='Exercise the dedicated E2B host boundary with two disposable root guests.')
parser.add_argument('--seed-volume', required=True, help='Docker volume containing team-api-key')
parser.add_argument('--output', type=Path, required=True, help='New evidence directory; must not exist')
parser.add_argument('--api-url', default='http://127.0.0.1:3000')
parser.add_argument('--proxy-url', default='http://127.0.0.1:3002')
args = parser.parse_args()
for url in (args.api_url, args.proxy_url):
    parsed = urlparse(url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password or (parsed.path not in ('', '/')):
        parser.error('Proof endpoints must be loopback HTTP URLs on this dedicated host')
if not os.geteuid() == 0:
    raise RuntimeError('Run as root on the dedicated Linux E2B host')
root = args.output.resolve()
root.mkdir(exist_ok=False)
(root / 'probe.mjs').write_bytes(Path(__file__).with_name('network-proof.mjs').read_bytes())
proof = 'launchpad-network-' + str(uuid.uuid4())
lock = json.loads(Path(__file__).with_name('runtime.lock.json').read_text())
image = lock['embed']['images']['node-e2b']
sdk_image = image['tag'].rsplit(':', 1)[0] + '@' + image['digest']
public = '9.9.9.254'
additions = []
servers = []
p = None
info = None
restore_forwarding = None
cmd = None
addresses = json.loads(subprocess.check_output(['ip', '-j', 'addr'], text=True))
if not all((a['local'] not in [public, 'fd42:1::1'] for i in addresses for a in i.get('addr_info', []))):
    raise RuntimeError('Network proof prerequisite or assertion failed')

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)

def add(*args):
    run(*args)
    additions.append(args)

def namespace(vm):
    matches = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\x00')
            if not any((('/tmp/fc-' + vm + '-').encode() in a for a in args)):
                continue
            if 'firecracker' not in os.readlink(proc / 'exe'):
                continue
            target = os.stat(proc / 'ns/net').st_ino
            names = [ns.name for ns in Path('/var/run/netns').glob('ns-*') if ns.stat().st_ino == target]
            matches += names
        except (FileNotFoundError, PermissionError):
            continue
    if not len(matches) == 1:
        raise RuntimeError(('VM namespace identity', vm, matches))
    return matches[0]
try:
    add('ip', 'addr', 'add', public + '/32', 'dev', 'lo')
    add('ip', '-6', 'addr', 'add', 'fd42:1::1/128', 'dev', 'lo')
    listener = "import socket,sys; s=socket.socket(socket.AF_INET6 if ':' in sys.argv[1] else socket.AF_INET); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind((sys.argv[1],int(sys.argv[2]))); s.listen(); print('ready',flush=True);\nwhile True:\n c,a=s.accept();c.sendall(b'proof');c.close()"
    for (addr, port) in [(public, 18373), ('fd42:1::1', 18375)]:
        server = subprocess.Popen(['python3', '-u', '-c', listener, addr, str(port)], stdout=subprocess.PIPE, text=True)
        servers.append(server)
        if not server.stdout.readline().strip() == 'ready':
            raise RuntimeError('Network proof prerequisite or assertion failed')
        with socket.create_connection((addr, port), 2) as s:
            if not s.recv(5) == b'proof':
                raise RuntimeError('Network proof prerequisite or assertion failed')
    cmd = ['docker', 'run', '--rm', '--cidfile', str(root / 'container-id'), '--network', 'host', '--mount', f'type=volume,source={args.seed_volume},target=/run/e2b,readonly', '--mount', f'type=bind,source={root},target=/probe', '--mount', f'type=bind,source={root}/probe.mjs,target=/app/probe.mjs,readonly', '--env', f'LAUNCHPAD_PROOF_API_URL={args.api_url}', '--env', f'LAUNCHPAD_PROOF_PROXY_URL={args.proxy_url}', '--env', f'LAUNCHPAD_PROOF_ID={proof}', '--entrypoint', 'node', sdk_image, '/app/probe.mjs']
    p = subprocess.Popen(cmd)
    deadline = time.monotonic() + 90
    while not (root / 'created.json').exists():
        if p.poll() is not None:
            raise RuntimeError('SDK exited before guest readiness')
        if not time.monotonic() < deadline:
            raise RuntimeError('Network proof prerequisite or assertion failed')
        time.sleep(0.1)
    info = json.loads((root / 'created.json').read_text())
    if not info['proof'] == proof:
        raise RuntimeError('Network proof prerequisite or assertion failed')
    peerNs = namespace(info['peer'])
    guestNs = namespace(info['guest'])
    slot = int(guestNs[3:])
    peerSlot = int(peerNs[3:])
    peerAddress = str(ipaddress.ip_address('10.11.0.0') + peerSlot)
    with socket.create_connection((peerAddress, 18374), 2) as s:
        pass
    add('ip', '-6', 'addr', 'add', 'fd42:2::1/64', 'dev', 'veth-' + str(slot))
    restore_forwarding = (guestNs, subprocess.check_output(['ip', 'netns', 'exec', guestNs, 'sysctl', '-n', 'net.ipv6.conf.all.forwarding'], text=True).strip())
    run('ip', 'netns', 'exec', guestNs, 'sysctl', '-q', '-w', 'net.ipv6.conf.all.forwarding=1')
    add('ip', 'netns', 'exec', guestNs, 'ip', '-6', 'addr', 'add', 'fd42:2::2/64', 'dev', 'eth0')
    add('ip', 'netns', 'exec', guestNs, 'ip', '-6', 'addr', 'add', 'fd42:3::1/64', 'dev', 'tap0')
    add('ip', 'netns', 'exec', guestNs, 'ip', '-6', 'route', 'add', 'default', 'via', 'fd42:2::1', 'dev', 'eth0')
    add('ip', '-6', 'route', 'add', 'fd42:3::/64', 'via', 'fd42:2::2', 'dev', 'veth-' + str(slot))
    (root / 'before-rules.json').write_bytes(subprocess.check_output(['nft', '-j', 'list', 'table', 'inet', 'launchpad_thread_vm']))
    (root / 'host.json').write_text(json.dumps({'proof': info['proof'], 'peerAddress': peerAddress, 'publicHost': public}))
    p.wait(timeout=90)
    if not p.returncode == 0:
        raise RuntimeError('Network proof prerequisite or assertion failed')
    (root / 'after-rules.json').write_bytes(subprocess.check_output(['nft', '-j', 'list', 'table', 'inet', 'launchpad_thread_vm']))

    def counts(path):
        result = {}
        for entry in json.loads(path.read_text())['nftables']:
            rule = entry.get('rule', {})
            if rule.get('chain') != 'prerouting':
                continue
            expressions = rule.get('expr', [])
            for expression in expressions:
                if 'counter' in expression:
                    result[rule['handle']] = expression['counter']['packets']
        return result
    before = counts(root / 'before-rules.json')
    after = counts(root / 'after-rules.json')
    deltas = {key: after[key] - value for (key, value) in before.items()}
    if not (len(deltas) == 3 and all((value > 0 for value in deltas.values()))):
        raise RuntimeError(deltas)
    print(json.dumps({'preroutingDropCounterDeltas': deltas}))
    print('Verified reachable host IPv4/IPv6 and peer controls were denied from a root guest; private preview rejected unauthenticated access.', flush=True)
finally:
    if p is not None and p.poll() is None:
        if info and (not (root / 'host.json').exists()):
            (root / 'host.json').write_text(json.dumps({'proof': info['proof'], 'error': 'host proof setup failed'}))
        try:
            p.wait(timeout=90)
        except subprocess.TimeoutExpired:
            cid = (root / 'container-id').read_text().strip()
            subprocess.run(['docker', 'stop', '--timeout', '10', cid], check=True)
            p.wait(timeout=15)
    cleanup_errors = []

    def clean(action):
        try:
            action()
        except Exception as error:
            cleanup_errors.append(str(error))

    if cmd is not None:
        cleanup = cmd.copy()
        index = cleanup.index('--cidfile')
        del cleanup[index:index + 2]
        cleanup.append('--cleanup')
        clean(lambda: subprocess.run(cleanup, check=True, timeout=60))
    for server in servers:
        clean(server.terminate)
        clean(lambda: server.wait(timeout=5))
    for command in reversed(additions):
        undo = list(command)
        undo[undo.index('add')] = 'del'
        clean(lambda: subprocess.run(undo, check=True, stdout=subprocess.DEVNULL))
    if restore_forwarding:
        namespace_name, value = restore_forwarding
        clean(lambda: subprocess.run(['ip', 'netns', 'exec', namespace_name, 'sysctl', '-q', '-w',
                                     'net.ipv6.conf.all.forwarding=' + value], check=True))
    clean(lambda: subprocess.run(['/usr/local/libexec/launchpad-host-firewall', 'check'], check=True))
    if cleanup_errors:
        raise RuntimeError('Proof cleanup needs attention: ' + '; '.join(cleanup_errors))
