// Taskpad service worker - cache-first for all app assets.
//
// IMPORTANT: bump CACHE_VERSION after every deployment so returning users
// get fresh assets instead of the old cached version. The old cache is
// deleted automatically on activate. Use a date string or build hash:
//   e.g. 'taskpad-2025-07-01' or 'taskpad-abc1234'
const CACHE_VERSION = 'taskpad-v1';

const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/app/sync-core.mjs',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only intercept same-origin GETs; let sync API calls pass through.
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Don't cache config.json - it may be updated between deployments.
  if (url.pathname === '/config.json') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
