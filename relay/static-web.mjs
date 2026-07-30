import { readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function cacheControl(pathname, filePath) {
  if (
    pathname === '/' ||
    basename(filePath).toLowerCase() === 'index.html' ||
    pathname.endsWith('/index.html') ||
    pathname.endsWith('/sw.js') ||
    pathname.endsWith('/manifest.json')
  ) {
    return 'no-cache';
  }
  if (pathname.startsWith('/_expo/static/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=86400';
}

function staticHeaders(pathname, filePath, length) {
  return {
    'Cache-Control': cacheControl(pathname, filePath),
    'Content-Security-Policy':
      "default-src 'self'; base-uri 'none'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; manifest-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self'",
    'Content-Length': length,
    'Content-Type':
      CONTENT_TYPES.get(extname(filePath).toLowerCase()) ??
      'application/octet-stream',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'Service-Worker-Allowed': '/',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

export async function tryServeStatic({ request, response, url, webRoot }) {
  if (!webRoot || !['GET', 'HEAD'].includes(request.method)) return false;
  if (url.pathname.startsWith('/v1/')) return false;

  const absoluteRoot = resolve(webRoot);
  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath =
    requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
  let filePath = resolve(absoluteRoot, relativePath);
  const pathFromRoot = relative(absoluteRoot, filePath);
  if (pathFromRoot.startsWith('..') || pathFromRoot.includes(':')) return false;

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!request.headers.accept?.includes('text/html')) return false;
    filePath = resolve(absoluteRoot, 'index.html');
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(
      200,
      staticHeaders(url.pathname, filePath, body.byteLength),
    );
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
