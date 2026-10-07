import importlib
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
_test_root = tempfile.TemporaryDirectory(prefix='mj-jobs-contract-')
os.environ['MJ_OUTPUT_DIR'] = str(Path(_test_root.name) / 'output')
os.environ['MJ_JOBS_DIR'] = str(Path(_test_root.name) / 'jobs')
server = importlib.import_module('server')


class ReadJobContractTests(unittest.TestCase):
    def setUp(self):
        self.original_jobs_dir = server.JOBS_DIR
        self.temp_jobs_dir = Path(tempfile.mkdtemp(prefix='jobs-case-', dir=_test_root.name))
        server.JOBS_DIR = self.temp_jobs_dir

    def tearDown(self):
        server.JOBS_DIR = self.original_jobs_dir
        for file_path in self.temp_jobs_dir.iterdir():
            file_path.unlink()
        self.temp_jobs_dir.rmdir()

    def write_job(self, payload):
        (self.temp_jobs_dir / 'job-1.json').write_text(__import__('json').dumps(payload), encoding='utf-8')
        return server.read_job('job-1')

    def test_exposes_nested_business_status_and_retry_contract(self):
        state = self.write_job({
            'ok': False,
            'status': 'aspect_not_applied',
            'retryAllowed': True,
            'submitted': False,
            'billed': False,
        })
        self.assertEqual(state['status'], 'done')
        self.assertEqual(state['resultStatus'], 'aspect_not_applied')
        self.assertIs(state['retryAllowed'], True)
        self.assertIs(state['submitted'], False)
        self.assertIs(state['billed'], False)
        self.assertIs(state['chargeKnown'], True)

    def test_preserves_snake_case_retry_flag_and_unknown_charge(self):
        state = self.write_job({'ok': False, 'status': 'failed', 'retry_allowed': True, 'submitted': True})
        self.assertIs(state['retryAllowed'], True)
        self.assertIsNone(state['billed'])
        self.assertIs(state['chargeKnown'], False)

    def test_zero_actual_deduction_is_known(self):
        state = self.write_job({'ok': False, 'status': 'aspect_not_applied', 'retry_allowed': True, 'actual_point_deduction': 0})
        self.assertIs(state['chargeKnown'], True)
        self.assertEqual(state['actualPointDeduction'], 0)


class BridgeRuntimeHealthTests(unittest.TestCase):
    def test_reports_path_resolved_node_as_available(self):
        with tempfile.TemporaryDirectory(prefix='bridge-runtime-') as root:
            root_path = Path(root)
            playwright = root_path / 'node_modules' / 'playwright' / 'package.json'
            playwright.parent.mkdir(parents=True)
            playwright.write_text('{}', encoding='utf-8')
            runner = root_path / 'mj_run.js'
            adapter = root_path / 'mxai_adapter.js'
            runner.write_text('', encoding='utf-8')
            adapter.write_text('', encoding='utf-8')
            with mock.patch.multiple(
                server,
                NODE_EXE=Path('node'),
                NODE_MODULES=root_path / 'node_modules',
                RUNNER=runner,
                ADAPTER_PATH=adapter,
            ), mock.patch.object(server.shutil, 'which', return_value='C:/tools/node.exe'):
                payload = server.health()
        self.assertTrue(payload['runtime']['nodeAvailable'])
        self.assertTrue(payload['runtime']['ready'])


if __name__ == '__main__':
    unittest.main()
