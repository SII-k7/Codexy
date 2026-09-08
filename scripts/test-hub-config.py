"""Credential initialization regression tests; uses only temporary directories."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('prepare-hub-config.py')

class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_config(self, host='first', *extra):
        return subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root),
                               '--hub-url', 'https://hub.example.ts.net:8443',
                               '--host-id', host, '--label', 'Test computer', *extra],
                              capture_output=True, text=True)

    def config(self):
        return json.loads((self.root / 'data/config.json').read_text(encoding='utf-8'))

    def test_initialization_hashes_match_without_printing_credentials(self):
        result = self.run_config()
        self.assertEqual(result.returncode, 0, result.stderr)
        owner = (self.root / 'access/phone-access.txt').read_text().strip()
        agent = json.loads((self.root / 'access/first-agent.json').read_text())
        config = self.config()
        self.assertEqual(config['ownerHash'], hashlib.sha256(owner.encode()).hexdigest())
        self.assertEqual(config['agents'][0]['tokenHash'], hashlib.sha256(agent['token'].encode()).hexdigest())
        self.assertNotIn(owner, result.stdout + result.stderr)
        self.assertNotIn(agent['token'], json.dumps(config) + result.stdout + result.stderr)

    def test_rerun_preserves_existing_credentials(self):
        self.assertEqual(self.run_config().returncode, 0)
        before = self.config()
        self.assertNotEqual(self.run_config().returncode, 0)
        self.assertEqual(self.config(), before)

    def test_add_agent_preserves_owner_and_first_computer(self):
        self.assertEqual(self.run_config().returncode, 0)
        before = self.config()
        result = self.run_config('second', '--add-agent')
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.config()
        self.assertEqual(after['ownerHash'], before['ownerHash'])
        self.assertEqual(after['agents'][0], before['agents'][0])
        self.assertEqual(after['agents'][1]['id'], 'second')
        self.assertNotEqual(after['agents'][0]['tokenHash'], after['agents'][1]['tokenHash'])
        self.assertNotEqual(self.run_config('second', '--add-agent').returncode, 0)
        self.assertEqual(self.config(), after)

    def test_invalid_id_cannot_escape_access_directory(self):
        self.assertNotEqual(self.run_config('../escape').returncode, 0)
        self.assertFalse((self.root / 'data/config.json').exists())

    def test_existing_access_file_is_never_overwritten(self):
        (self.root / 'access').mkdir()
        path = self.root / 'access/first-agent.json'
        path.write_text('preserve me')
        self.assertNotEqual(self.run_config().returncode, 0)
        self.assertEqual(path.read_text(), 'preserve me')
        self.assertFalse((self.root / 'data/config.json').exists())

if __name__ == '__main__':
    unittest.main()
