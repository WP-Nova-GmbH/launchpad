import contextlib
import copy
import hashlib
import importlib.util
import signal
import types
import tempfile
import os
import json
import select
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('launchpad_workload', Path(__file__).with_name('workload.py'))
workload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workload)


class KernelStopReceiptTest(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='launchpad-kernel-stop-')))
        self.groups = [root / ('a' * 32), root / ('b' * 32)]
        for group in self.groups:
            group.mkdir()
            (group / 'cgroup.events').write_text('populated 1\n')
        self.gate = {'bootId': 'same-boot', 'epoch': 4, 'sealedBy': 'c' * 32}
        self.clock = 0
        self.notifications = []
        self.notification = lambda group: (group / 'cgroup.events').write_text('populated 0\n')
        self.stack.enter_context(mock.patch.object(workload, 'ROOT', root))
        self.stack.enter_context(mock.patch.object(workload, 'BOOT', types.SimpleNamespace(read_text=lambda: 'same-boot\n')))
        self.stack.enter_context(mock.patch.object(workload.time, 'monotonic', side_effect=lambda: self.clock))
        self.stack.enter_context(mock.patch.object(workload.time, 'sleep', side_effect=AssertionError('shutdown must wait on kernel events')))
        self.stack.enter_context(mock.patch.object(workload, 'inventory', side_effect=self.inventory))
        self.stack.enter_context(mock.patch.object(select, 'poll', side_effect=self.poller))

    def inventory(self, gate):
        groups = [{'id': group.name, 'bootId': 'same-boot'} for group in self.groups
                  if (group / 'cgroup.events').read_text() == 'populated 1\n']
        return {**gate, 'groups': groups, 'stopped': not groups}

    def poller(self):
        current = types.SimpleNamespace(group=None)

        def register(events, flags):
            self.assertEqual(flags, select.POLLPRI | select.POLLERR)
            current.group = Path(events.name).parent

        def poll(milliseconds):
            # Every owned group must receive kill before waiting for any one.
            for group in self.groups:
                self.assertEqual((group / 'cgroup.kill').read_text(), '1')
            self.notifications.append((current.group, milliseconds))
            self.clock += 2
            self.notification(current.group)
            return [(1, select.POLLPRI)]

        return types.SimpleNamespace(register=register, poll=poll)

    def test_waits_for_async_kernel_notifications_with_one_shared_deadline(self):
        receipt = workload.stop_workloads(self.gate)
        self.assertTrue(receipt['stopped'])
        self.assertEqual(receipt['groups'], [])
        self.assertEqual(self.notifications, [(self.groups[0], 5000), (self.groups[1], 3000)])
        self.assertEqual((receipt['bootId'], receipt['epoch'], receipt['sealedBy']), ('same-boot', 4, 'c' * 32))

    def test_timeout_never_returns_an_empty_receipt_for_a_surviving_child(self):
        self.notification = lambda group: None
        with self.assertRaisesRegex(RuntimeError, 'Kernel workload receipt is unavailable'):
            workload.stop_workloads(self.gate)
        self.assertFalse(self.inventory(self.gate)['stopped'])
        self.assertGreaterEqual(self.clock, 5)
        self.assertTrue(all((group / 'cgroup.kill').exists() for group in self.groups))

    def test_later_survivor_does_not_receive_another_full_timeout(self):
        self.notification = lambda group: ((group / 'cgroup.events').write_text('populated 0\n')
                                           if group == self.groups[0] else None)
        with self.assertRaisesRegex(RuntimeError, 'Kernel workload receipt is unavailable'):
            workload.stop_workloads(self.gate)
        self.assertFalse(self.inventory(self.gate)['stopped'])
        self.assertEqual(self.notifications[1][1], 3000)

    def test_changed_boot_or_seal_cannot_be_reported_as_stopped(self):
        original = copy.deepcopy(self.gate)
        for field, changed in [('bootId', 'different-boot'), ('sealedBy', 'd' * 32), ('epoch', 5)]:
            self.gate.update(original)
            self.clock = 0
            for group in self.groups:
                (group / 'cgroup.events').write_text('populated 1\n')

            def notify(group):
                (group / 'cgroup.events').write_text('populated 0\n')
                self.gate[field] = changed

            self.notification = notify
            with self.assertRaisesRegex(RuntimeError, 'shutdown ownership changed'):
                workload.stop_workloads(self.gate)


class WarmRestoreGateTest(unittest.TestCase):
    def setUp(self):
        self.input = {'boot': {'version': 1, 'allocationId': 'new-allocation', 'operationId': 'new-operation',
                              'threadId': 'thread', 'generation': 5},
                      'source': {'allocationId': 'old-allocation', 'operationId': 'old-operation',
                                 'threadId': 'thread', 'generation': 2, 'bootId': 'same-kernel-boot',
                                 'captureOperationId': 'capture-operation', 'sealEpoch': 7}}
        self.gate = {'bootId': 'same-kernel-boot', 'epoch': 7,
                     'sealedBy': hashlib.sha256(b'capture-operation').hexdigest()[:32]}
        self.events = []
        self.stopped = True
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(workload, 'coordinator_locked', lambda: contextlib.nullcontext()))
        self.stack.enter_context(mock.patch.object(workload, 'locked', lambda: contextlib.nullcontext(self.gate)))
        self.stack.enter_context(mock.patch.object(workload, 'inventory', lambda gate: {'stopped': self.stopped}))
        self.stop = self.stack.enter_context(mock.patch.object(workload, 'stop_coordinator', side_effect=lambda *args: self.events.append('stopped')))
        self.stack.enter_context(mock.patch.object(workload, 'sync_json', side_effect=lambda *args: self.events.append('write')))
        self.stack.enter_context(mock.patch.object(workload.os, 'chown'))
        self.stack.enter_context(mock.patch('pwd.getpwnam', return_value=types.SimpleNamespace(pw_uid=1000, pw_gid=1000)))

    def test_stops_before_closed_rebind_and_retries_without_incrementing_epoch(self):
        receipt = workload.prepare_warm_restore(self.input)
        self.assertEqual(self.events, ['stopped', 'write', 'write'])
        self.assertEqual(receipt['targetSealEpoch'], 8)
        self.assertEqual(self.gate['bootId'], 'same-kernel-boot')
        self.assertEqual(self.gate['sealedBy'], hashlib.sha256(b'new-operation').hexdigest()[:32])
        self.events.clear()
        self.assertEqual(workload.prepare_warm_restore(self.input), receipt)
        self.assertEqual(self.events, ['stopped', 'write'])
        self.assertEqual(self.gate['epoch'], 8)

    def test_accepts_a_later_closed_capture_from_an_already_restored_source(self):
        self.gate['warmRestore'] = {'older': 'completed-restore'}
        self.assertEqual(workload.prepare_warm_restore(self.input)['targetSealEpoch'], 8)

    def test_mismatched_or_busy_source_never_stops_or_rebinds(self):
        for changed in ({'bootId': 'other'}, {'epoch': 6}, {'sealedBy': None}, {'sealedBy': 'other'}):
            original = copy.deepcopy(self.gate)
            self.gate.update(changed)
            with self.assertRaises(RuntimeError):
                workload.prepare_warm_restore(self.input)
            self.gate = original
        self.stopped = False
        with self.assertRaises(RuntimeError):
            workload.prepare_warm_restore(self.input)
        self.assertEqual(self.events, [])

    def test_missing_coordinator_evidence_preserves_closed_source(self):
        before = copy.deepcopy(self.gate)
        self.stop.side_effect = FileNotFoundError('no root-owned coordinator record')
        with self.assertRaises(FileNotFoundError):
            workload.prepare_warm_restore(self.input)
        self.assertEqual(self.gate, before)
        self.assertEqual(self.events, [])


class OwnedCoordinatorStopTest(unittest.TestCase):
    def setUp(self):
        self.scope = {'allocationId': 'allocation', 'operationId': 'operation', 'threadId': 'thread', 'generation': 2}
        self.busy = True
        self.group_path = '/sys/fs/cgroup/user/launchpad-coordinators/' + 'a' * 32
        self.group = mock.Mock()
        self.group.__str__ = lambda _: self.group_path
        self.kill = mock.Mock()
        self.kill.write_text.side_effect = lambda value: setattr(self, 'busy', False)
        self.group.__truediv__ = mock.Mock(return_value=self.kill)
        self.server = mock.Mock()
        self.server.read_bytes.return_value = b'immutable-server'
        self.server.resolve.return_value = '/opt/launchpad/server/t3'
        self.record = {'pid': 42, 'startTicks': '123', 'executableSha256': hashlib.sha256(b'immutable-server').hexdigest()}
        self.self_group = '/user'
        self.process_group = self.group_path.removeprefix('/sys/fs/cgroup')
        self.identity = {'startTicks': '123', 'state': 'S'}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(workload, 'SERVER', self.server))
        self.stack.enter_context(mock.patch.object(workload, 'coordinator_record', return_value=(self.group, self.record)))
        self.stack.enter_context(mock.patch.object(workload, 'populated', side_effect=lambda group: self.busy))
        self.stack.enter_context(mock.patch.object(workload, 'process_identity', side_effect=lambda pid: self.identity))
        self.stack.enter_context(mock.patch.object(workload, 'Path', side_effect=self.path))
        self.pidfd = self.stack.enter_context(mock.patch.object(workload.os, 'pidfd_open', return_value=91, create=True))
        self.stack.enter_context(mock.patch.object(workload.os, 'close'))
        self.send = self.stack.enter_context(mock.patch.object(signal, 'pidfd_send_signal', create=True))
        self.stack.enter_context(mock.patch.object(workload, 'wait_cgroup_event', side_effect=self.wait))

    def path(self, value):
        if value == '/proc/self/cgroup':
            return types.SimpleNamespace(read_text=lambda: '0::' + self.self_group)
        if value == '/proc/42/cgroup':
            return types.SimpleNamespace(read_text=lambda: '0::' + self.process_group)
        if value == '/proc/42/exe':
            return self.server
        raise AssertionError('Unexpected process inspection')

    def wait(self, *args):
        if self.busy:
            raise RuntimeError('graceful exit not completed')

    def test_stops_only_the_captured_pid_then_its_owned_cgroup(self):
        workload.stop_coordinator(self.scope, 'boot')
        self.pidfd.assert_called_once_with(42)
        self.send.assert_called_once_with(91, signal.SIGTERM)
        self.kill.write_text.assert_called_once_with('1')
        self.assertFalse(self.busy)

    def test_never_kills_the_envd_control_group_or_a_reused_pid(self):
        self.self_group = self.process_group
        with self.assertRaises(RuntimeError):
            workload.stop_coordinator(self.scope, 'boot')
        self.self_group = '/user'
        self.identity = {'startTicks': '999', 'state': 'S'}
        with self.assertRaises(RuntimeError):
            workload.stop_coordinator(self.scope, 'boot')
        self.pidfd.assert_not_called()
        self.send.assert_not_called()
        self.kill.write_text.assert_not_called()

    def test_an_escaped_live_coordinator_is_not_mistaken_for_an_empty_group(self):
        self.busy = False
        self.process_group = '/user'
        with self.assertRaises(RuntimeError):
            workload.stop_coordinator(self.scope, 'boot')
        self.send.assert_not_called()
        self.kill.write_text.assert_not_called()


class CoordinatorLaunchTest(unittest.TestCase):
    def test_root_launcher_records_ownership_then_execs_fixed_server_as_user(self):
        self.launch('restore', False)

    def test_workflow_launcher_only_exports_guest_mode_to_coordinator(self):
        self.launch('initial', True)

    def launch(self, mode, workflow):
        with tempfile.TemporaryDirectory(prefix='launchpad-coordinator-') as temporary, contextlib.ExitStack() as stack:
            root=Path(temporary);groups=root/'groups';state=root/'state'
            groups.mkdir();state.mkdir();server=root/'t3';server.write_bytes(b'immutable-server')
            scope={'allocationId':'allocation','operationId':'operation','threadId':'thread','generation':2}
            stack.enter_context(mock.patch.object(workload,'COORDINATORS',groups))
            stack.enter_context(mock.patch.object(workload,'COORDINATOR_STATE',state))
            stack.enter_context(mock.patch.object(workload,'SERVER',server))
            stack.enter_context(mock.patch.object(workload,'BOOT',types.SimpleNamespace(read_text=lambda:'captured-boot')))
            stack.enter_context(mock.patch.object(workload,'coordinator_locked',lambda:contextlib.nullcontext()))
            stack.enter_context(mock.patch.object(workload,'immutable'))
            stack.enter_context(mock.patch.object(workload,'workflow_guest',return_value=workflow))
            stack.enter_context(mock.patch.object(workload,'process_identity',return_value={'startTicks':'123'}))
            stack.enter_context(mock.patch.dict(os.environ,{'LAUNCHPAD_COORDINATOR_SCOPE':json.dumps(scope),'HOME':'/root'}))
            stack.enter_context(mock.patch('pwd.getpwnam',return_value=types.SimpleNamespace(pw_uid=1000,pw_gid=1000,pw_dir='/home/user',pw_name='user')))
            groups_call=stack.enter_context(mock.patch.object(os,'setgroups'))
            uid_call=stack.enter_context(mock.patch.object(os,'setuid'))
            gid_call=stack.enter_context(mock.patch.object(os,'setgid'))
            stack.enter_context(mock.patch.object(os,'chdir'))
            execute=stack.enter_context(mock.patch.object(os,'execv',side_effect=RuntimeError('exec captured')))
            with self.assertRaisesRegex(RuntimeError,'exec captured'):
                workload.run_coordinator('a'*64,mode)
            groups_call.assert_called_once_with([]);uid_call.assert_called_once_with(1000);gid_call.assert_called_once_with(1000)
            self.assertEqual(os.environ['HOME'],'/home/user')
            self.assertEqual(os.environ['USER'],'user')
            self.assertNotIn('LAUNCHPAD_COORDINATOR_SCOPE',os.environ)
            self.assertEqual(os.environ.get('LAUNCHPAD_WORKFLOW_GUEST'), '1' if workflow else None)
            record=json.loads(next(state.glob('*.json')).read_text())
            self.assertEqual(record['scope'],scope);self.assertEqual(record['startTicks'],'123')
            self.assertEqual(record['pid'],os.getpid())
            self.assertEqual(execute.call_args.args[0],'/usr/bin/flock')
            expected = [str(server), '__thread-vm-serve', '--receipt-sha256', 'a' * 64]
            if mode != 'initial':
                expected.append('--' + mode)
            self.assertEqual(execute.call_args.args[1][-len(expected):], expected)

    def test_late_old_coordinator_start_is_denied_after_a_new_restore_binding(self):
        with tempfile.TemporaryDirectory(prefix='launchpad-coordinator-') as temporary:
            root=Path(temporary)
            source={'allocationId':'source','operationId':'old','threadId':'thread','generation':2}
            target={**source,'operationId':'new','generation':5}
            (root/'restore-binding.json').write_text(json.dumps({'boot':target}))
            with mock.patch.object(workload,'COORDINATOR_STATE',root),mock.patch.object(workload,'immutable'):
                with self.assertRaises(RuntimeError):workload.coordinator_admission(source)
                workload.coordinator_admission(target)


class WorkflowRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='launchpad-workflow-recovery-')))
        self.groups, self.state = self.root / 'groups', self.root / 'state'
        self.groups.mkdir(); self.state.mkdir()
        self.group_id = 'a' * 32
        self.group = self.groups / self.group_id
        self.proc = self.root / 'proc' / '42'
        (self.proc / 'fd').mkdir(parents=True)
        (self.proc / 'cgroup').write_text('0::' + str(self.group))
        self.boot = self.root / 'boot'
        self.boot.write_text('current-boot\n')
        dump_policy = self.root / 'dump-policy'
        dump_policy.write_text('0\n')
        self.gate = {'bootId': 'current-boot', 'epoch': 4, 'sealedBy': None}
        self.owner = types.SimpleNamespace(st_uid=10001, st_gid=10001)
        self.environment = types.SimpleNamespace(st_uid=0, st_mode=0o400)
        native = types.SimpleNamespace(st_gid=1000, st_mode=0o751)
        self.stack.enter_context(mock.patch.object(workload, 'ROOT', self.groups))
        self.stack.enter_context(mock.patch.object(workload, 'STATE', self.state))
        self.stack.enter_context(mock.patch.object(workload, 'BOOT', self.boot))
        self.stack.enter_context(mock.patch.object(workload, 'DUMP_POLICY', dump_policy))
        self.stack.enter_context(mock.patch.object(workload, 'locked', lambda: contextlib.nullcontext(self.gate)))
        self.uid = self.stack.enter_context(mock.patch.object(os, 'getuid', return_value=0))
        self.marked = self.stack.enter_context(mock.patch.object(workload, 'workflow_guest', return_value=True))
        self.identity = self.stack.enter_context(mock.patch.object(workload, 'process_identity', return_value={'startTicks': '42', 'state': 'S'}))
        self.immutable = self.stack.enter_context(mock.patch.object(workload, 'immutable', return_value=native))
        self.same_executable = self.stack.enter_context(mock.patch.object(os.path, 'samestat', return_value=True))
        stat = Path.stat
        def proc_stat(path, *args, **kwargs):
            if path == self.proc: return self.owner
            if path == self.proc / 'environ': return self.environment
            if path == self.proc / 'exe': return native
            return stat(path, *args, **kwargs)
        self.stack.enter_context(mock.patch.object(Path, 'stat', proc_stat))
        self.stack.enter_context(mock.patch.object(workload, 'Path', side_effect=lambda value: self.root / value.removeprefix('/') if str(value).startswith('/proc/42') else Path(value)))

    def add_group(self, kind='terminal', *, setup_owner=True):
        self.group.mkdir()
        (self.group / 'cgroup.events').write_text('populated 1\n')
        (self.group / 'cgroup.procs').write_text('42\n')
        self.record = {'id': self.group_id, 'kind': kind, 'leaderPid': 42, 'startTicks': '42',
                       'bootId': 'current-boot', 'workflow': True}
        if setup_owner: self.record['setupOwner'] = True
        self.save_record()

    def save_record(self):
        (self.state / (self.group_id + '.json')).write_text(json.dumps(self.record))

    def inspect(self):
        return workload.workflow_recovery_state(self.gate)

    def test_empty_workloads_and_single_passive_setup_owner_can_recover_without_killing(self):
        self.assertTrue(self.inspect()['recoverable'])
        self.add_group()
        value = self.inspect()
        self.assertTrue(value['recoverable'])
        self.assertFalse(value['stopped'])
        self.assertEqual(value['groups'], [self.record])
        self.assertEqual(value['epoch'], 4)
        self.assertFalse((self.group / 'cgroup.kill').exists())
        self.assertEqual((self.group / 'cgroup.procs').read_text(), '42\n')

    def test_provider_orphans_and_unknown_workloads_are_not_empty(self):
        self.add_group('provider', setup_owner=False)
        for kind in ['provider', 'process', 'terminal', 'transfer']:
            with self.subTest(kind=kind):
                self.record['kind'] = kind; self.save_record()
                with self.assertRaises(RuntimeError): self.inspect()
        self.assertFalse((self.group / 'cgroup.kill').exists())

    def test_setup_waiting_for_arm_or_about_to_fork_does_not_pass_singleton_check(self):
        self.add_group()
        script = self.proc / 'fd' / '3'
        script.write_text('protected script')
        with self.assertRaises(RuntimeError): self.inspect()
        script.unlink()
        script.symlink_to('/unlinked-protected-script')
        with self.assertRaises(RuntimeError): self.inspect()

    def test_setup_descendants_and_nested_cgroups_block_recovery(self):
        self.add_group()
        (self.group / 'cgroup.procs').write_text('42\n43\n')
        with self.assertRaises(RuntimeError): self.inspect()
        (self.group / 'cgroup.procs').write_text('42\n')
        (self.group / 'child').mkdir()
        with self.assertRaises(RuntimeError): self.inspect()

    def test_closed_script_descriptor_must_be_observable(self):
        self.add_group()
        lstat = Path.lstat
        def denied(path, *args, **kwargs):
            if path == self.proc / 'fd' / '3': raise PermissionError('not readable')
            return lstat(path, *args, **kwargs)
        with mock.patch.object(Path, 'lstat', denied):
            with self.assertRaises(PermissionError): self.inspect()

    def test_changed_boot_seal_or_setup_identity_never_authorizes_recovery(self):
        self.add_group()
        for field, value in [('bootId', 'other-boot'), ('sealedBy', 'b' * 32), ('epoch', -1)]:
            with self.subTest(field=field):
                before = dict(self.gate); self.gate[field] = value
                with self.assertRaises((RuntimeError, ValueError)): self.inspect()
                self.gate.update(before)
        self.identity.return_value = {'startTicks': '99', 'state': 'S'}
        with self.assertRaises(RuntimeError): self.inspect()
        self.identity.return_value = {'startTicks': '42', 'state': 'S'}
        self.same_executable.return_value = False
        with self.assertRaises(RuntimeError): self.inspect()
        self.same_executable.return_value = True
        self.owner.st_uid = 1000
        with self.assertRaises(RuntimeError): self.inspect()

    def test_identity_and_membership_are_checked_again_before_returning(self):
        self.add_group()
        self.identity.side_effect = [{'startTicks': '42', 'state': 'S'}, {'startTicks': '99', 'state': 'S'}]
        with self.assertRaises(RuntimeError): self.inspect()

    def test_setup_record_requires_the_original_complete_identity(self):
        self.add_group()
        for field, value in [('leaderPid', 43), ('startTicks', '99'), ('bootId', 'other'), ('workflow', False)]:
            with self.subTest(field=field):
                before = dict(self.record); self.record[field] = value; self.save_record()
                with self.assertRaises((RuntimeError, FileNotFoundError)): self.inspect()
                self.record = before; self.save_record()
        (self.state / (self.group_id + '.json')).write_text('{malformed')
        with self.assertRaises(ValueError): self.inspect()

    def test_native_action_is_root_only_and_coordinator_delegates_exact_shape(self):
        self.uid.return_value = 1000
        with mock.patch.object(os, 'execv', side_effect=RuntimeError('delegated')) as execute:
            with self.assertRaisesRegex(RuntimeError, 'delegated'):
                workload.main(['workflow-recovery-state'])
        execute.assert_called_once_with(workload.WORKFLOW_EXEC, [workload.WORKFLOW_EXEC, 'workflow-recovery-state'])
        self.uid.return_value = 10001
        with self.assertRaises(RuntimeError): workload.main(['workflow-recovery-state'])
        self.uid.return_value = 0
        self.marked.return_value = False
        with self.assertRaises(RuntimeError): workload.main(['workflow-recovery-state'])
        self.marked.return_value = True
        with self.assertRaises(ValueError): workload.main(['workflow-recovery-state', 'unexpected'])


class WorkflowBrokerRecoveryTest(unittest.TestCase):
    def test_real_entrypoint_limits_recovery_to_coordinator_and_zero_arguments(self):
        cc = shutil.which('cc')
        if not cc: self.skipTest('C compiler unavailable')
        # Compile the actual entry point with OS identity/control sinks. No setuid
        # installation or Linux guest is needed to exercise its allowlist.
        entry = Path(__file__).with_name('workflow-exec.c').read_text().split('int main(int argc, char **argv)', 1)[1]
        harness = r'''
#include <stdio.h>
#include <limits.h>
#include <string.h>
#include <assert.h>
#define COORDINATOR_ID 1000
#define STDIN_FILENO 0
#define CHECKPOINT_PYTHON "python"
#define CHECKPOINT_READER "reader"
#define WORKFLOW_GIT "git"
#define SETUP_OWNER "owner"
enum workload_kind { ordinary, provider, checkpoint_reader, workflow_git, setup_owner };
static int uid=1000, euid=0, marked=1, calls=0;
static int getuid(void){return uid;} static int geteuid(void){return euid;}
static int workflow_enabled(void){return marked;}
static int inspect_provider_peer(char **args){(void)args;return -1;}
static int number(char *s,int min,int max){(void)s;(void)min;(void)max;return -1;}
static int duplicate_fd(int a,int b){(void)a;(void)b;return -1;}
static int close(int fd){(void)fd;return 0;}
static int prepare_workspace(void){return -1;}
static int open_setup_script(char *s){(void)s;return -1;}
static int exec_workload(char *cwd,char **cmd,enum workload_kind kind){(void)cwd;(void)cmd;(void)kind;return -1;}
static int exec_control(int count,char **args){assert(count==1);assert(!strcmp(args[0],"workflow-recovery-state"));calls++;return -1;}
int broker_main(int argc,char **argv)
''' + entry + r'''
int main(void){
 char *args[]={"broker","workflow-recovery-state","unexpected",NULL};
 broker_main(2,args);assert(calls==1);
 broker_main(3,args);assert(calls==1);
 uid=10001;broker_main(2,args);assert(calls==1);
 uid=1000;euid=1000;broker_main(2,args);assert(calls==1);
 euid=0;marked=0;broker_main(2,args);assert(calls==1);
 uid=0;marked=1;broker_main(2,args);assert(calls==1);
 return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='launchpad-broker-recovery-') as temporary:
            source = Path(temporary) / 'broker.c'; source.write_text(harness)
            binary = Path(temporary) / 'broker'
            compiled = subprocess.run([cc, '-std=c11', '-Wall', '-Werror', str(source), '-o', str(binary)], capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            subprocess.run([str(binary)], check=True, capture_output=True)


class WorkflowWorkloadTest(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='launchpad-workflow-')))
        self.groups, self.state = root / 'groups', root / 'state'
        self.groups.mkdir()
        self.state.mkdir()
        self.work_id = 'a' * 32
        self.group = self.groups / self.work_id
        self.record = self.state / (self.work_id + '.json')
        self.gate = {'bootId': 'current-boot', 'sealedBy': None, 'lastSweep': float('inf')}
        self.stack.enter_context(mock.patch.object(workload, 'ROOT', self.groups))
        self.stack.enter_context(mock.patch.object(workload, 'STATE', self.state))
        self.stack.enter_context(mock.patch.object(workload, 'locked', lambda: contextlib.nullcontext(self.gate)))
        self.marked = self.stack.enter_context(mock.patch.object(workload, 'workflow_guest', return_value=True))
        self.uid = self.stack.enter_context(mock.patch.object(os, 'getuid', return_value=1000))
        self.identity = self.stack.enter_context(mock.patch.object(workload, 'process_identity', return_value={'startTicks': '42'}))
        self.cwd = '/workspace/project/private'
        self.launch = ['run-workflow', self.work_id, 'terminal', self.cwd, '--', '/bin/sh', '-c', 'arbitrary argv']

    def test_registers_original_pid_in_workflow_cgroup_before_dropping(self):
        with mock.patch.object(os, 'execv', side_effect=RuntimeError('exec captured')) as execute:
            with self.assertRaisesRegex(RuntimeError, 'exec captured'):
                workload.main(self.launch)
        execute.assert_called_once_with(workload.WORKFLOW_EXEC, [workload.WORKFLOW_EXEC, 'exec', *self.launch[3:]])
        self.assertEqual((self.group / 'cgroup.procs').read_text(), str(os.getpid()))
        self.assertEqual(json.loads(self.record.read_text()), {
            'id': self.work_id, 'kind': 'terminal', 'leaderPid': os.getpid(),
            'bootId': 'current-boot', 'startTicks': '42', 'workflow': True,
        })

    def test_unmarked_or_wrong_user_cannot_enter_workflow_launcher(self):
        self.marked.return_value = False
        with self.assertRaises(RuntimeError):
            workload.main(self.launch)
        self.marked.return_value = True
        self.uid.return_value = 10001
        with self.assertRaises(RuntimeError):
            workload.main(self.launch)
        self.assertFalse(self.group.exists())

    def test_workflow_rejects_relative_working_directory_before_registration(self):
        self.launch[3] = 'relative/path'
        with self.assertRaisesRegex(ValueError, 'Invalid workflow working directory'):
            workload.main(self.launch)
        self.assertFalse(self.group.exists())

    def test_signal_matches_current_group_and_leader_or_kills_only_owned_descendants(self):
        self.group.mkdir()
        (self.group / 'cgroup.events').write_text('populated 1\n')
        (self.group / 'cgroup.procs').write_text('42\n')
        self.record.write_text(json.dumps({
            'id': self.work_id, 'bootId': 'current-boot', 'workflow': True,
            'leaderPid': 42, 'startTicks': '42',
        }))
        with mock.patch.object(os, 'pidfd_open', return_value=91, create=True), \
                mock.patch.object(os, 'close'), \
                mock.patch.object(signal, 'pidfd_send_signal', create=True) as send:
            self.assertTrue(workload.signal_workflow(self.gate, self.work_id, 42, 'TERM'))
            send.assert_called_once_with(91, signal.SIGTERM)
            self.identity.return_value = {'startTicks': 'reused'}
            self.assertFalse(workload.signal_workflow(self.gate, self.work_id, 42, 'TERM'))
            send.assert_called_once()
        with self.assertRaises(RuntimeError):
            workload.signal_workflow(self.gate, self.work_id, 43, 'KILL')
        self.assertFalse((self.group / 'cgroup.kill').exists())
        self.assertTrue(workload.signal_workflow(self.gate, self.work_id, 42, 'KILL'))
        self.assertEqual((self.group / 'cgroup.kill').read_text(), '1')

    def test_configures_guest_dump_policy_and_rejects_weaker_runtime_policy(self):
        scope = self.state / 'suid_dumpable'
        scope.write_text('1\n')
        with mock.patch.object(workload, 'DUMP_POLICY', scope):
            with self.assertRaisesRegex(RuntimeError, 'memory protection'):
                workload.require_workflow_dump_policy()
            workload.require_workflow_dump_policy(configure=True)
            self.assertEqual(scope.read_text(), '0\n')
            workload.require_workflow_dump_policy()
            scope.unlink()
            with self.assertRaises(FileNotFoundError):
                workload.require_workflow_dump_policy(configure=True)

    def test_workflow_provider_bypasses_readable_shell_shim(self):
        with (
            mock.patch.object(workload, 'require_workflow_dump_policy') as policy,
            mock.patch.object(workload, 'workflow_native', return_value=(None, Path('/pinned/codex'), None)),
            mock.patch.object(os, 'execv', side_effect=RuntimeError('exec captured')) as execute,
        ):
            with self.assertRaisesRegex(RuntimeError, 'exec captured'):
                workload.main(['run-workflow', self.work_id, 'provider', self.cwd, '--', 'codex', 'app-server'])
        policy.assert_called_once_with()
        execute.assert_called_once_with(
            workload.WORKFLOW_EXEC,
            [workload.WORKFLOW_EXEC, 'exec-provider', self.cwd, '--', '/pinned/codex', 'app-server'],
        )

    def test_workflow_checkpoint_reader_uses_fixed_execute_only_python(self):
        with (
            mock.patch.object(workload, 'require_workflow_dump_policy') as policy,
            mock.patch.object(workload, 'immutable', return_value=types.SimpleNamespace(
                st_gid=workload.COORDINATOR_UID, st_mode=workload.WORKFLOW_NATIVE_MODE,
            )) as immutable,
            mock.patch.object(os, 'execv', side_effect=RuntimeError('exec captured')) as execute,
        ):
            with self.assertRaisesRegex(RuntimeError, 'exec captured'):
                workload.main([
                    'run-workflow', self.work_id, 'process', self.cwd, '--',
                    '/usr/bin/python3', '-IS', str(workload.CHECKPOINT_READER), 'capture',
                ])
        policy.assert_called_once_with()
        self.assertEqual(immutable.call_args_list, [
            mock.call(workload.CHECKPOINT_PYTHON), mock.call(workload.CHECKPOINT_READER),
        ])
        execute.assert_called_once_with(
            workload.WORKFLOW_EXEC, [workload.WORKFLOW_EXEC, 'exec-checkpoint-reader', self.cwd, 'capture'],
        )

    def test_coordinator_launched_workflow_git_uses_fixed_execute_only_binary(self):
        info = types.SimpleNamespace(st_gid=workload.COORDINATOR_UID, st_mode=workload.WORKFLOW_NATIVE_MODE)
        for digit, git in [('b', 'git'), ('c', '/usr/bin/git')]:
            with (
                self.subTest(git=git),
                mock.patch.object(workload, 'require_workflow_dump_policy') as policy,
                mock.patch.object(workload, 'immutable', return_value=info) as immutable,
                mock.patch.object(os, 'execv', side_effect=RuntimeError('exec captured')) as execute,
            ):
                with self.assertRaisesRegex(RuntimeError, 'exec captured'):
                    workload.main([
                        'run-workflow', digit * 32, 'process', self.cwd, '--', git, 'ls-files', '--others', '-z',
                    ])
                policy.assert_called_once_with()
                immutable.assert_called_once_with(workload.WORKFLOW_GIT)
                execute.assert_called_once_with(workload.WORKFLOW_EXEC, [
                    workload.WORKFLOW_EXEC, 'exec-git', self.cwd, '--', 'ls-files', '--others', '-z',
                ])

    def test_workflow_setup_waits_for_native_ready_before_locking_and_binds_exact_group(self):
        self.uid.return_value = 0
        inside_gate = False

        @contextlib.contextmanager
        def gate_lock():
            nonlocal inside_gate
            inside_gate = True
            try:
                yield self.gate
            finally:
                inside_gate = False

        def native(operation, pid, *identity):
            self.assertEqual(inside_gate, operation == 'arm')
            self.assertEqual(pid, 42)
            self.assertEqual(identity, () if operation == 'capture' else ('current-boot:42',))
            return {'protocol': 4, 'identity': 'current-boot:42', 'owned': True, 'fullStop': False}

        def validate(*args):
            self.assertTrue(inside_gate)
            self.assertEqual(args, (self.gate, self.work_id, 42, '42'))

        with (
            mock.patch.object(workload, 'locked', gate_lock),
            mock.patch.object(workload, 'native_setup_control', side_effect=native),
            mock.patch.object(workload, 'setup_cgroup_id', return_value=self.work_id),
            mock.patch.object(workload, 'require_live_setup_owner', side_effect=validate) as verify,
        ):
            captured = workload.workflow_setup_control(['capture', '42'])
            expected = f'workflow-vm:{self.work_id}:current-boot:42'
            self.assertEqual(captured['identity'], expected)
            self.assertEqual(workload.workflow_setup_control(['arm', '42', expected])['identity'], expected)
            self.assertEqual(verify.call_count, 2)

    def test_workflow_setup_cannot_arm_after_capture_when_launches_are_sealed(self):
        self.uid.return_value = 0
        self.gate['sealedBy'] = 'b' * 32
        expected = f'workflow-vm:{self.work_id}:current-boot:42'
        with mock.patch.object(workload, 'native_setup_control') as native:
            with self.assertRaisesRegex(RuntimeError, 'Workload launches are sealed'):
                workload.workflow_setup_control(['arm', '42', expected])
            native.assert_not_called()

    def test_uncertain_workflow_setup_arm_stops_the_group_before_unlocking(self):
        self.uid.return_value = 0
        self.group.mkdir()
        expected = f'workflow-vm:{self.work_id}:current-boot:42'
        with (
            mock.patch.object(workload, 'require_live_setup_owner', return_value=self.group),
            mock.patch.object(workload, 'native_setup_control', side_effect=RuntimeError('Lost arm reply')),
            mock.patch.object(workload, 'wait_cgroup_event') as drained,
        ):
            with self.assertRaisesRegex(RuntimeError, 'Lost arm reply'):
                workload.workflow_setup_control(['arm', '42', expected])
            self.assertEqual((self.group / 'cgroup.kill').read_text(), '1')
            drained.assert_called_once_with(self.group, 'populated', '0')

    def test_workflow_setup_launch_registers_owner_in_its_terminal_cgroup(self):
        info = types.SimpleNamespace(st_gid=workload.COORDINATOR_UID, st_mode=workload.WORKFLOW_NATIVE_MODE)
        script = '/tmp/launchpad-workflow-setup-' + 'b' * 32 + '.sh'
        with (
            mock.patch.object(workload, 'require_workflow_dump_policy') as policy,
            mock.patch.object(workload, 'immutable', return_value=info) as immutable,
            mock.patch.object(os, 'execv', side_effect=RuntimeError('exec captured')) as execute,
        ):
            with self.assertRaisesRegex(RuntimeError, 'exec captured'):
                workload.main([
                    'run-workflow', self.work_id, 'terminal', self.cwd, '--', str(workload.RESOURCE_MONITOR),
                    '--setup-owner-v4', '--script-file-v1', script,
                ])
        self.assertTrue(json.loads(self.record.read_text())['setupOwner'])
        self.assertEqual((self.group / 'cgroup.procs').read_text(), str(os.getpid()))
        policy.assert_called_once_with()
        immutable.assert_called_once_with(workload.WORKFLOW_SETUP_OWNER)
        execute.assert_called_once_with(
            workload.WORKFLOW_EXEC, [workload.WORKFLOW_EXEC, 'exec-setup-owner', self.cwd, script],
        )

    def test_workflow_setup_stop_waits_for_owned_cgroup_and_retries_after_reap(self):
        self.uid.return_value = 0
        self.group.mkdir()
        events = self.group / 'cgroup.events'
        events.write_text('populated 1\n')
        other = self.groups / ('b' * 32)
        other.mkdir()
        self.record.write_text(json.dumps({
            'id': self.work_id, 'kind': 'terminal', 'leaderPid': 42, 'startTicks': '42',
            'bootId': 'current-boot', 'workflow': True, 'setupOwner': True,
        }))
        expected = f'workflow-vm:{self.work_id}:current-boot:42'

        def drained(group, key, value, *, seconds):
            self.assertEqual((group, key, value, seconds), (self.group, 'populated', '0', 5))
            self.assertEqual((group / 'cgroup.kill').read_text(), '1')
            events.write_text('populated 0\n')

        with mock.patch.object(workload, 'wait_cgroup_event', side_effect=drained) as wait:
            with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
                workload.workflow_setup_control(['stop', '43', expected])
            self.assertFalse((self.group / 'cgroup.kill').exists())
            receipt = workload.workflow_setup_control(['stop', '42', expected])
            self.assertTrue(receipt['fullStop'])
            self.assertFalse((other / 'cgroup.kill').exists())
            events.unlink()
            (self.group / 'cgroup.kill').unlink()
            self.group.rmdir()
            self.record.unlink()
            self.assertEqual(workload.workflow_setup_control(['stop', '42', expected]), receipt)
            wait.assert_called_once()
            self.gate['bootId'] = 'later-boot'
            with self.assertRaisesRegex(RuntimeError, 'boot changed'):
                workload.workflow_setup_control(['stop', '42', expected])

    def test_verifies_peer_only_against_current_pinned_provider_and_rechecks_identity(self):
        self.group.mkdir()
        membership = self.group / 'cgroup.procs'
        membership.write_text('42\n')
        provider = {
            'id': self.work_id, 'bootId': 'current-boot', 'kind': 'provider',
            'workflow': True, 'leaderPid': 42, 'startTicks': '42',
        }
        self.record.write_text(json.dumps(provider))
        scope = self.state / 'suid_dumpable'
        scope.write_text('0\n')
        self.identity.return_value = {'startTicks': '42', 'processGroup': 42}
        process_owner = types.SimpleNamespace(st_uid=workload.WORKFLOW_UID, st_gid=workload.WORKFLOW_UID)
        environment_owner = types.SimpleNamespace(st_uid=0, st_mode=0o400)
        def proc_stat(path):
            if path.name == 'environ':
                return environment_owner
            return process_owner
        with (
            mock.patch.object(workload, 'DUMP_POLICY', scope),
            mock.patch.object(workload, 'workflow_native', return_value=(None, None, object())),
            mock.patch.object(os.path, 'samestat', return_value=True),
            mock.patch.object(Path, 'stat', proc_stat),
            mock.patch.object(os, 'pidfd_open', return_value=91, create=True),
            mock.patch.object(os, 'close') as close,
            mock.patch.object(workload, 'native_peer_control', return_value=0) as native,
        ):
            def verify(pid=42, start_ticks='42'):
                return workload.verify_workflow_provider_peer(
                    self.gate, self.work_id, pid, start_ticks, 3000, 4000,
                )

            self.assertFalse(verify(pid=43))
            self.assertFalse(verify(start_ticks='99'))
            native.assert_not_called()
            self.assertTrue(verify())
            native.assert_called_once_with('inspect-workflow-provider-socket', 91, 42, 3000, 4000)
            close.assert_called_once_with(91)
            environment_owner.st_uid = workload.WORKFLOW_UID
            self.assertFalse(verify())
            native.assert_called_once()
            environment_owner.st_uid = 0
            native.return_value = 1
            self.assertFalse(verify())
            native.return_value = 74
            with self.assertRaisesRegex(RuntimeError, 'socket attribution'):
                verify()

            def replaced(*_args):
                membership.write_text('43\n')
                return 0

            native.side_effect = replaced
            self.assertFalse(verify())

    def test_probes_cross_uid_socket_attribution_during_workflow_enrollment(self):
        child = mock.MagicMock()
        child.__enter__.return_value.pid = 42
        with (
            mock.patch.object(workload, 'require_workflow_dump_policy') as scope,
            mock.patch.object(workload.subprocess, 'Popen', return_value=child) as spawn,
            mock.patch.object(os, 'pidfd_open', return_value=91, create=True),
            mock.patch.object(os, 'close') as close,
            mock.patch.object(workload, 'native_peer_control', return_value=74) as native,
        ):
            with self.assertRaisesRegex(RuntimeError, 'socket attribution'):
                workload.require_workflow_peer_support()
        scope.assert_called_once_with(configure=True)
        self.assertEqual(spawn.call_args.kwargs['user'], workload.WORKFLOW_UID)
        native.assert_called_once_with('probe-workflow-provider-pidfd', 91)
        close.assert_called_once_with(91)


if __name__ == '__main__':
    unittest.main()
