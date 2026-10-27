import copy
import os
import subprocess
import tempfile
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('host_firewall', Path(__file__).with_name('host-firewall.py'))
firewall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firewall)


class FirewallFingerprintTest(unittest.TestCase):
    def setUp(self):
        self.policy = {'nftables': [
            {'metainfo': {'version': 'test'}},
            {'table': {'name': 'launchpad_thread_vm', 'family': 'inet', 'handle': 1}},
            {'chain': {'name': 'input', 'type': 'filter', 'hook': 'input', 'prio': -190, 'policy': 'accept'}},
            {'rule': {'chain': 'input', 'handle': 2, 'expr': [
                {'match': {'left': {'meta': {'key': 'iifname'}}, 'op': '==', 'right': 'veth-*'}},
                {'counter': {'packets': 0, 'bytes': 0}}, {'drop': None}]}},
            {'rule': {'chain': 'input', 'expr': [{'accept': None}]}}
        ]}

    def test_live_counters_and_kernel_handles_do_not_invalidate(self):
        live = copy.deepcopy(self.policy)
        live['nftables'][1]['table']['handle'] = 902
        live['nftables'][3]['rule']['handle'] = 903
        live['nftables'][3]['rule']['expr'][1]['counter'] = {'packets': 42, 'bytes': 4096}
        self.assertEqual(firewall.rules_fingerprint(self.policy), firewall.rules_fingerprint(live))

    def test_missing_or_weakened_rules_invalidate(self):
        changed = copy.deepcopy(self.policy)
        changed['nftables'][3]['rule']['expr'][-1] = {'accept': None}
        self.assertNotEqual(firewall.rules_fingerprint(self.policy), firewall.rules_fingerprint(changed))
        changed = copy.deepcopy(self.policy)
        del changed['nftables'][3]
        self.assertNotEqual(firewall.rules_fingerprint(self.policy), firewall.rules_fingerprint(changed))
        changed = copy.deepcopy(self.policy)
        changed['nftables'][3]['rule']['expr'][0]['match']['right'] = 'wrong-interface-*'
        self.assertNotEqual(firewall.rules_fingerprint(self.policy), firewall.rules_fingerprint(changed))

    def test_rule_order_is_part_of_the_boundary(self):
        changed = copy.deepcopy(self.policy)
        changed['nftables'][3], changed['nftables'][4] = changed['nftables'][4], changed['nftables'][3]
        self.assertNotEqual(firewall.rules_fingerprint(self.policy), firewall.rules_fingerprint(changed))

    def test_missing_table_and_invalid_response_are_refused(self):
        for document in [{}, {'nftables': []}, {'nftables': [{'table': {'name': 'other', 'family': 'inet'}}]}]:
            with self.assertRaises(ValueError):
                firewall.rules_fingerprint(document)


class FirewallKernelTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('LAUNCHPAD_FIREWALL_NAMESPACE_TEST') == '1',
                         'requires sudo unshare --net on the dedicated Linux host')
    def test_real_rules_and_receipt(self):
        self.assertNotEqual(os.readlink('/proc/self/ns/net'), os.readlink('/proc/1/ns/net'),
                            'refusing to change the host network namespace')
        with tempfile.TemporaryDirectory(prefix='launchpad-firewall-') as temp:
            firewall.POLICY = Path(temp) / 'policy.nft'
            firewall.POLICY.write_bytes(Path(__file__).with_name('host-firewall.nft').read_bytes())
            firewall.RECEIPT = Path(temp) / 'run/receipt.json'
            firewall.main('apply')
            firewall.main('check')
            subprocess.run(['nft', 'insert', 'rule', 'inet', 'launchpad_thread_vm', 'input', 'accept'], check=True)
            with self.assertRaises(ValueError):
                firewall.main('check')
            firewall.main('apply')
            firewall.main('check')
            firewall.POLICY.write_text(firewall.POLICY.read_text() + '\n# changed without reload\n')
            with self.assertRaises(ValueError):
                firewall.main('check')
            firewall.main('apply')
            firewall.main('check')
            firewall.RECEIPT.unlink()
            with self.assertRaises(FileNotFoundError):
                firewall.main('check')


if __name__ == '__main__':
    unittest.main()
