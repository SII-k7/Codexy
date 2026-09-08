// The tunnel only exposes the existing sanitized mobile API, never arbitrary
// localhost requests, pairing, filesystem access, or App Server RPC methods.
export function allowedRoute(method, path) {
  if (typeof path === 'string') path = path.replace(/%3a/gi, ':');
  if (typeof path !== 'string' || path.length > 512 || /[%\\?#]/.test(path)) return false;
  if (method === 'GET' && /^\/(snapshot|status|sessions|events|remote-prompts)$/.test(path)) return true;
  if (method === 'PATCH' && path === '/preferences') return true;
  if (method === 'POST' && path === '/remote-prompts') return true;
  if (method === 'GET' && /^\/remote-prompts\/[a-zA-Z0-9_-]+$/.test(path)) return true;
  if (method === 'POST' && /^\/remote-prompts\/[a-zA-Z0-9_-]+\/cancel$/.test(path)) return true;
  if (method === 'GET' && /^\/sessions\/[a-zA-Z0-9_:-]+\/(prompts|reply-summary|control|runtime)$/.test(path)) return true;
  if (method === 'PATCH' && /^\/sessions\/[a-zA-Z0-9_:-]+\/(control|goal)$/.test(path)) return true;
  return method === 'POST' && /^\/(sessions\/[a-zA-Z0-9_:-]+\/actions|events\/[a-zA-Z0-9_:-]+\/ack)$/.test(path);
}

export function publicResult(value, hostId) {
  if (Array.isArray(value)) return value.map((item) => publicResult(item, hostId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    'device_secret', 'relay_token', 'hookToken', 'deviceSecret', 'pairing_code', 'pairing_expires_at',
  ].includes(key)).map(([key, item]) => [key,
    ['device_id', 'device_ref'].includes(key) ? hostId : key === 'endpoint' ? null : publicResult(item, hostId),
  ]));
}
