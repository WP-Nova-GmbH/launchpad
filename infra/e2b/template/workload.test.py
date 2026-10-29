import contextlib
import copy
import hashlib
import importlib.util
import signal
import types
import tempfile
import os
import json
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('launchpad_workload', Path(__file__).with_name('workload.py'))
workload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workload)


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
            stack.enter_context(mock.patch.object(workload,'process_identity',return_value={'startTicks':'123'}))
            stack.enter_context(mock.patch.dict(os.environ,{'LAUNCHPAD_COORDINATOR_SCOPE':json.dumps(scope),'HOME':'/root'}))
            stack.enter_context(mock.patch('pwd.getpwnam',return_value=types.SimpleNamespace(pw_uid=1000,pw_gid=1000,pw_dir='/home/user',pw_name='user')))
            groups_call=stack.enter_context(mock.patch.object(os,'setgroups'))
            uid_call=stack.enter_context(mock.patch.object(os,'setuid'))
            gid_call=stack.enter_context(mock.patch.object(os,'setgid'))
            stack.enter_context(mock.patch.object(os,'chdir'))
            execute=stack.enter_context(mock.patch.object(os,'execv',side_effect=RuntimeError('exec captured')))
            with self.assertRaisesRegex(RuntimeError,'exec captured'):
                workload.run_coordinator('a'*64,'restore')
            groups_call.assert_called_once_with([]);uid_call.assert_called_once_with(1000);gid_call.assert_called_once_with(1000)
            self.assertEqual(os.environ['HOME'],'/home/user')
            self.assertEqual(os.environ['USER'],'user')
            self.assertNotIn('LAUNCHPAD_COORDINATOR_SCOPE',os.environ)
            record=json.loads(next(state.glob('*.json')).read_text())
            self.assertEqual(record['scope'],scope);self.assertEqual(record['startTicks'],'123')
            self.assertEqual(record['pid'],os.getpid())
            self.assertEqual(execute.call_args.args[0],'/usr/bin/flock')
            self.assertEqual(execute.call_args.args[1][-5:],[str(server),'__thread-vm-serve','--receipt-sha256','a'*64,'--restore'])

    def test_late_old_coordinator_start_is_denied_after_a_new_restore_binding(self):
        with tempfile.TemporaryDirectory(prefix='launchpad-coordinator-') as temporary:
            root=Path(temporary)
            source={'allocationId':'source','operationId':'old','threadId':'thread','generation':2}
            target={**source,'operationId':'new','generation':5}
            (root/'restore-binding.json').write_text(json.dumps({'boot':target}))
            with mock.patch.object(workload,'COORDINATOR_STATE',root),mock.patch.object(workload,'immutable'):
                with self.assertRaises(RuntimeError):workload.coordinator_admission(source)
                workload.coordinator_admission(target)


if __name__ == '__main__':
    unittest.main()
