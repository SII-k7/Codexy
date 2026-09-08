"""Initialize Hub credentials or enroll one additional computer. Prints no secrets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
parser.add_argument('--hub-url', required=True)
parser.add_argument('--host-id', required=True)
parser.add_argument('--label', required=True)
parser.add_argument('--add-agent', action='store_true', help='Preserve the owner key and enroll another computer')
args = parser.parse_args()
url = urlsplit(args.hub_url)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
    parser.error('--hub-url must be an HTTPS origin without credentials, path, or query')
if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', args.host_id):
    parser.error('--host-id must contain 1-64 letters, numbers, underscores, or hyphens')
if not args.label.strip() or len(args.label) > 80:
    parser.error('--label must contain 1-80 characters')

os.umask(0o077)
root = args.root.resolve()
for name in ('data', 'access'):
    (root / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    (root / name).chmod(0o700)
config_file = root / 'data/config.json'
if args.add_agent:
    if not config_file.exists():
        parser.error('Initialize the Hub before using --add-agent')
    config = json.loads(config_file.read_text(encoding='utf-8'))
    if any(agent['id'] == args.host_id for agent in config['agents']):
        parser.error('This host ID already exists; configuration preserved')
else:
    if config_file.exists():
        parser.error('Existing configuration preserved; use --add-agent for another computer')
    owner = secrets.token_urlsafe(32)
    config = {'ownerHash': hashlib.sha256(owner.encode()).hexdigest(), 'agents': []}

agent_token = secrets.token_urlsafe(32)
config['agents'].append({'id': args.host_id, 'label': args.label.strip(),
                         'tokenHash': hashlib.sha256(agent_token.encode()).hexdigest()})
files = {root / 'access' / (args.host_id + '-agent.json'): json.dumps({
    'hubUrl': args.hub_url.rstrip('/'), 'hostId': args.host_id, 'token': agent_token,
}, ensure_ascii=False, indent=2)}
if not args.add_agent:
    files[root / 'access/phone-access.txt'] = owner + '\n'
if any(path.exists() for path in files):
    parser.error('Enrollment file already exists; no credentials overwritten')
for path, value in files.items():
    with path.open('x', encoding='utf-8') as handle:
        handle.write(value)
    path.chmod(0o600)
# Atomic replacement avoids leaving a partially written server configuration.
temporary = config_file.with_name('config-' + secrets.token_hex(8) + '.tmp')
with temporary.open('x', encoding='utf-8') as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
temporary.chmod(0o600)
temporary.replace(config_file)
print('Private enrollment files saved in access/. No credentials printed. Restart the Hub after adding an agent.')
