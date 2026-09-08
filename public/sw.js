const CACHE_VERSION = 'codexy-shell-v3';
const CORE_ASSETS = [
  '/',
  '/manifest.json',
  '/apple-touch-icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('codexy-shell-'))
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/', response.clone());
    return response;
  } catch {
    return (await cache.match('/')) ?? Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await network) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/h/')) {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (
    url.pathname.startsWith('/_expo/static/') ||
    ['font', 'image', 'manifest', 'script', 'style'].includes(
      request.destination,
    )
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: 'Codexy', body: 'Codex 状态已更新。' };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Codexy', {
      body: payload.body || 'Codex 状态已更新。',
      data: payload.data ?? { url: '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag || 'codexy-agent-status',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = event.notification.data ?? {};
  const destinationPath = notificationData.session_ref
    ? `/?session=${encodeURIComponent(notificationData.session_ref)}${notificationData.device_ref ? `&device=${encodeURIComponent(notificationData.device_ref)}` : ''}`
    : notificationData.url || '/';
  const destination = new URL(destinationPath, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(
      async (clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            if ('navigate' in client) await client.navigate(destination);
            return client.focus();
          }
        }
        return self.clients.openWindow(destination);
      },
    ),
  );
});
