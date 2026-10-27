import os,sys,json,subprocess,tempfile,selectors,time,urllib.request,pathlib,shutil,stat
assert os.getuid()==1000
def immutable_image_file(name):
 path=pathlib.Path(name)
 assert path.is_absolute() and path.resolve(strict=True)==path, f'Indirect image path: {path}'
 info=path.lstat()
 assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022, f'Writable image file: {path}'
 for parent in path.parents:
  info=parent.stat()
  assert stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022, f'Writable image directory: {parent}'
 return path
# Inspect the finalized image, after E2B's post-Dockerfile configuration has run.
for name in ('/usr/local/bin/launchpad-workload','/usr/local/bin/launchpad-activity','/usr/local/bin/codex'):
 immutable_image_file(name)
native=json.loads(immutable_image_file('/opt/launchpad/codex-native.json').read_text())
immutable_image_file(native['executable'])
inventory=json.loads(subprocess.run(['launchpad-workload','inspect'],check=True,capture_output=True,text=True,timeout=10).stdout)
assert inventory['stopped'] and inventory['sealedBy'] is None, 'workload tracker did not initialize at boot'
import hashlib
assert hashlib.sha256(pathlib.Path('/usr/local/bin/launchpad-workload').read_bytes()).hexdigest()==os.environ['LAUNCHPAD_WORKLOAD_SHA256']
assert hashlib.sha256(pathlib.Path('/etc/systemd/system/launchpad-workloads.service').read_bytes()).hexdigest()==os.environ['LAUNCHPAD_WORKLOAD_SERVICE_SHA256']
assert pathlib.Path('/workspace').is_dir() and os.access('/workspace',os.W_OK)
assert not pathlib.Path('/run/e2b/team-api-key').exists()
assert not any(os.environ.get(k) for k in ('E2B_API_KEY','CLERK_SECRET_KEY','DATABASE_URL'))
resources=json.loads(os.environ['LAUNCHPAD_EXPECTED_RESOURCES'])
assert os.cpu_count()==resources['cpuCount'], f'Unexpected vCPU count: {os.cpu_count()}'
mem_kib=int(next(line.split()[1] for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:')))
# Linux reserves a small part of the configured RAM for its kernel.
assert resources['memoryMB']*1024*0.95 <= mem_kib <= resources['memoryMB']*1024, f'Unexpected guest RAM: {mem_kib} KiB'
fs=os.statvfs('/workspace')
free_bytes=fs.f_bavail*fs.f_frsize
assert 0 < resources['minUsableDiskMb'] <= resources['minFreeDiskMb']
assert free_bytes >= resources['minUsableDiskMb']*1024*1024, f'Runner did not retain its requested free disk space: {free_bytes} bytes'
versions={}
for exe in ['launchpad-server','node','codex','pnpm','git','gh','cloudflared']:
 p=subprocess.run([exe,'--version'],capture_output=True,text=True,check=True,timeout=15)
 versions[exe]=p.stdout.strip().splitlines()[0]
assert versions['node']=='v26.8.2'
assert versions['codex']=='codex-cli 0.159.3'
assert versions['pnpm']=='11.10.0'
assert versions['cloudflared'].startswith('cloudflared version 2026.5.2 ')
# SDK commands need not inherit template ENV; the server also resolves tools on PATH.
assert pathlib.Path(shutil.which('cloudflared')).resolve()==pathlib.Path('/usr/local/bin/cloudflared')
ptyjs="""const pty=require('/opt/launchpad/server/node_modules/node-pty');
const p=pty.spawn('/bin/bash',['-lc','printf runner-pty-ok'],{cwd:'/workspace',env:process.env});
let data='';const timer=setTimeout(()=>{p.kill();process.exit(2)},10000);
p.onData(chunk=>data+=chunk);p.onExit(({exitCode})=>{clearTimeout(timer);if(exitCode!==0||!data.includes('runner-pty-ok'))process.exit(1);console.log('pty-ok')});"""
ptyresult=subprocess.run(['node','-e',ptyjs],capture_output=True,text=True,timeout=15)
assert ptyresult.returncode==0, 'Native PTY failed: '+ptyresult.stderr
monitor=subprocess.run(['/opt/launchpad/server/resource-monitor/t3-resource-monitor'],input='{"type":"configure","version":3,"rootPid":'+str(os.getpid())+',"sampleIntervalMs":0}\n{"type":"processTable","version":3,"requestId":"runner-proof"}\n{"type":"shutdown","version":3}\n',capture_output=True,text=True,timeout=10,check=True)
assert 'runner-proof' in monitor.stdout, 'monitor did not return requested process table'
# Exercise the packaged enrollment command against a guest-loopback relay fixture.
# Actual relay signature, access and retry transactions have separate PG tests.
import http.server,threading,base64
scope={'allocationId':'runner-proof-allocation','threadId':'runner-proof-thread','repositoryId':'runner-proof-repository','generation':2}
seen=[]
class EnrollmentRelay(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  try:
   assert self.path=='/v1/thread-vms/enroll'
   request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
   parts=request['proof'].split('.')
   payload=json.loads(base64.urlsafe_b64decode(parts[1]+'='*(-len(parts[1])%4)))
   assert payload['seed']=='runner-fixture-seed'
   assert payload['allocationId']==scope['allocationId']
   assert payload['operationId']=='runner-fixture-operation'
   seen.append((payload['environmentId'],payload['environmentPublicKey']))
   if len(seen)==1:
    self.close_connection=True
    return
   body=json.dumps({'environmentId':payload['environmentId'],'scope':scope,'relayIssuer':origin,'cloudMintPublicKey':'fixture-public-key','environmentCredential':'runner-fixture-credential'}).encode()
   self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  except Exception:
   self.send_error(500)
relay=http.server.ThreadingHTTPServer(('127.0.0.1',0),EnrollmentRelay)
origin=f'http://127.0.0.1:{relay.server_port}'
relay_thread=threading.Thread(target=relay.serve_forever,daemon=True);relay_thread.start()
enrollment_home=tempfile.mkdtemp(prefix='launchpad-enrollment-smoke-')
payload=json.dumps({'version':1,'operationId':'runner-fixture-operation','scope':scope,'relayUrl':origin,'relayIssuer':origin,'seed':'runner-fixture-seed'})+'\n'
try:
 def enroll():
  return subprocess.run(['launchpad-server','__thread-vm-enroll','--base-dir',enrollment_home],input=payload,capture_output=True,text=True,timeout=30)
 failed=enroll();assert failed.returncode!=0, 'Lost enrollment response must not succeed'
 first=enroll();second=enroll()
 assert first.returncode==0 and second.returncode==0, 'Packaged enrollment retry failed'
 assert len(seen)==2 and seen[0]==seen[1], 'Enrollment retry changed its identity or contacted relay again'
 assert first.stdout==second.stdout, 'Enrollment retry changed its receipt'
 receipt=json.loads(first.stdout)
 assert receipt['enrolled'] and receipt['threadId']==scope['threadId'] and receipt['generation']==scope['generation']
 for result in (failed,first,second):
  assert 'runner-fixture-seed' not in result.stdout+result.stderr and 'runner-fixture-credential' not in result.stdout+result.stderr, 'Enrollment leaked fixture credentials'
finally:
 relay.shutdown();relay.server_close();relay_thread.join(timeout=5)

root=tempfile.mkdtemp(prefix='launchpad-runner-smoke-')
env={**os.environ,'T3CODE_LOG_LEVEL':'Debug','T3CODE_HOME':root,'T3CODE_NO_BROWSER':'1','T3CODE_EXECUTOR_SELF_UPDATE':'0'}
p=subprocess.Popen(['launchpad-server','serve','--host','127.0.0.1','--port','3773','--base-dir',root,'--no-browser'],cwd='/workspace',env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
logs=pathlib.Path(root)/'startup.log';logs.touch(mode=0o600)
try:
 sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
 deadline=time.monotonic()+60;buffer=b''
 with logs.open('ab') as f:
  while b'startup phase: complete' not in buffer:
   remaining=deadline-time.monotonic()
   assert remaining>0, 'server readiness deadline; private startup log retained in guest'
   assert sel.select(remaining), 'server readiness deadline'
   chunk=os.read(p.stdout.fileno(),65536)
   assert chunk, 'server exited before readiness; private startup log retained in guest'
   f.write(chunk);f.flush();buffer+=chunk
 with urllib.request.urlopen('http://127.0.0.1:3773/',timeout=10) as response:
  assert response.status==200 and b'<html' in response.read().lower(), 'bundled web client unavailable'
 db=pathlib.Path(root)/'userdata/state.sqlite'
 assert db.exists(), 'server database missing'
 print(json.dumps({'versions':versions,'resources':{'cpuCount':os.cpu_count(),'memoryKiB':mem_kib,'freeDiskBytes':free_bytes},'workloadTracking':True,'pty':True,'resourceMonitor':True,'serverReady':True,'bundledClient':True,'managementCredentialsAbsent':True,'packagedEnrollment':True,'enrollmentLostReplyRecovery':True,'uid':os.getuid()}))
finally:
 p.terminate()
 try:p.wait(timeout=15)
 except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
