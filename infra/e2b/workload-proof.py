import json,os,pathlib,subprocess,uuid,select,time
helper=pathlib.Path('/usr/local/bin/launchpad-workload')
subprocess.run([str(helper),'initialize'],check=True)
def run(*args,check=True,env=None):
 return subprocess.run(['runuser','-u','user','--',str(helper),*args],capture_output=True,text=True,check=check,timeout=10,env=env)
def inspect():return json.loads(run('inspect').stdout)
initial=inspect();assert initial['stopped'] and initial['sealedBy'] is None
work=uuid.uuid4().hex; operation=uuid.uuid4().hex
base=pathlib.Path('/workspace/workload-proof');base.mkdir();base.chmod(0o777)
for name in ('ready','release'):os.mkfifo(base/name,0o666);os.chmod(base/name,0o666)
child="""import os
if os.fork():os._exit(0)
os.setsid()
with open('/workspace/workload-proof/ready','w') as f:f.write('ready')
with open('/workspace/workload-proof/release') as f:f.read()
"""
p=subprocess.Popen(['runuser','-u','user','--',str(helper),'run',work,'process','--','python3','-c',child],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
with (base/'ready').open() as f:assert f.read()=='ready'
assert p.wait(timeout=10)==0
current=inspect();assert not current['stopped'] and [g['id'] for g in current['groups']]==[work]
assert not pathlib.Path('/proc/'+str(current['groups'][0]['leaderPid'])).exists()
sealed=json.loads(run('seal',current['bootId'],operation).stdout);assert sealed['sealedBy']==operation and not sealed['stopped']
subprocess.run([str(helper),'initialize'],check=True);assert inspect()['sealedBy']==operation
rejected=run('run',uuid.uuid4().hex,'process','--','touch',str(base/'must-not-exist'),check=False)
assert rejected.returncode==74 and not (base/'must-not-exist').exists()
assert run('reopen',current['bootId'],uuid.uuid4().hex,check=False).returncode==74
assert run('reopen',str(uuid.uuid4()),operation,check=False).returncode==74
# Subscribe before releasing the actual detached child; no timing sleeps.
events=pathlib.Path('/sys/fs/cgroup/user/launchpad-workloads')/work/'cgroup.events'
with events.open() as f:
 poll=select.poll();poll.register(f,select.POLLPRI|select.POLLERR)
 with (base/'release').open('w') as writer:writer.write('exit')
 deadline=time.monotonic()+10
 while True:
  f.seek(0)
  if 'populated 0' in f.read():break
  assert time.monotonic()<deadline
  poll.poll(max(1,int((deadline-time.monotonic())*1000)))
assert inspect()['stopped']
assert run('run-transfer',current['bootId'],uuid.uuid4().hex,str(sealed['epoch']),uuid.uuid4().hex,'--','true',check=False).returncode==74
transferred=run('run-transfer',current['bootId'],operation,str(sealed['epoch']),uuid.uuid4().hex,'--','printf','transfer-ok')
assert transferred.stdout=='transfer-ok' and inspect()['stopped']
run('reopen',current['bootId'],operation)
resealed=json.loads(run('seal',current['bootId'],operation).stdout)
assert resealed['epoch']>sealed['epoch']
assert run('run-transfer',current['bootId'],operation,str(sealed['epoch']),uuid.uuid4().hex,'--','true',check=False).returncode==74
run('reopen',current['bootId'],operation)
nested=run('run',uuid.uuid4().hex,'process','--',str(helper),'run',uuid.uuid4().hex,'process','--','printf','nested-ok')
assert nested.stdout=='nested-ok' and inspect()['stopped']
value='literal $(do-not-execute) `nor-this` spaces'
result=run('run',uuid.uuid4().hex,'terminal','--','python3','-c','import os,sys;print(os.getcwd());print(sys.argv[1]);print(os.environ["LAUNCHPAD_PROOF"])',value,env={**os.environ,'LAUNCHPAD_PROOF':value})
assert result.stdout.splitlines()[1:]==[value,value]
assert inspect()['stopped']
stopped_work=uuid.uuid4().hex;stopped_operation=uuid.uuid4().hex
p=subprocess.Popen(['runuser','-u','user','--',str(helper),'run',stopped_work,'process','--','python3','-c',child],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
with (base/'ready').open() as reader:assert reader.read()=='ready'
assert p.wait(timeout=10)==0
running=inspect();assert not running['stopped']
run('seal',running['bootId'],stopped_operation)
assert run('stop',running['bootId'],uuid.uuid4().hex,check=False).returncode==74
assert run('stop',str(uuid.uuid4()),stopped_operation,check=False).returncode==74
assert not inspect()['stopped']
events=pathlib.Path('/sys/fs/cgroup/user/launchpad-workloads')/stopped_work/'cgroup.events'
with events.open() as handle:
 poll=select.poll();poll.register(handle,select.POLLPRI|select.POLLERR)
 run('stop',running['bootId'],stopped_operation)
 deadline=time.monotonic()+10
 while True:
  handle.seek(0)
  if 'populated 0' in handle.read():break
  assert time.monotonic()<deadline
  poll.poll(max(1,int((deadline-time.monotonic())*1000)))
assert inspect()['stopped'] and inspect()['sealedBy']==stopped_operation
run('reopen',running['bootId'],stopped_operation)
print(json.dumps({'trackedStopVerified':True,'staleStopRejected':True,'detachedChildTracked' :True,'sealBlocksLaunch':True,'staleReopenRejected':True,'reinitializePreservesSeal':True,'stdioAndArgumentsPreserved':True,'allWorkloadsStopped':True,'staleTransferEpochRejected':True,'helperSha256':__import__('hashlib').sha256(helper.read_bytes()).hexdigest()}))
