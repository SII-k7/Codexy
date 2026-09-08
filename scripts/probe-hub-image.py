"""Check the Docker Official Images copy in ECR without Docker privileges."""
import hashlib
import json
import urllib.request

registry = 'https://public.ecr.aws'
repo = 'docker/library/node'
accept = ', '.join([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
])

def fetch(path, token=None):
    headers = {'Accept': accept}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(registry + path, headers=headers), timeout=20) as response:
        return response.read()

token = json.loads(fetch('/token/?service=public.ecr.aws&scope=repository:docker/library/node:pull'))['token']
index_raw = fetch('/v2/' + repo + '/manifests/22-alpine', token)
index = json.loads(index_raw)
selected = next(item for item in index['manifests'] if item.get('platform', {}).get('os') == 'linux' and item['platform'].get('architecture') == 'amd64')
manifest_raw = fetch('/v2/' + repo + '/manifests/' + selected['digest'], token)
assert 'sha256:' + hashlib.sha256(manifest_raw).hexdigest() == selected['digest']
manifest = json.loads(manifest_raw)
config_raw = fetch('/v2/' + repo + '/blobs/' + manifest['config']['digest'], token)
assert 'sha256:' + hashlib.sha256(config_raw).hexdigest() == manifest['config']['digest']
config = json.loads(config_raw)
layer_url = registry + '/v2/' + repo + '/blobs/' + manifest['layers'][0]['digest']
headers = {'Authorization': 'Bearer ' + token, 'Range': 'bytes=0-1023'}
with urllib.request.urlopen(urllib.request.Request(layer_url, headers=headers), timeout=20) as response:
    sample = response.read(1024)
    assert len(sample) == 1024
print(json.dumps({
    'source': 'public.ecr.aws/docker/library/node:22-alpine',
    'index_digest': 'sha256:' + hashlib.sha256(index_raw).hexdigest(),
    'platform_digest': selected['digest'],
    'platform': config['os'] + '/' + config['architecture'],
    'layers': len(manifest['layers']),
    'compressed_bytes': sum(layer['size'] for layer in manifest['layers']),
    'blob_download': 'verified',
}))
