/* Regional Weather Centre — service worker (app-shell cache, live data passthrough) */
const CACHE = 'rwc-shell-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only manage same-origin app-shell assets. Cross-origin weather APIs, proxies,
  // fonts and map tiles always go straight to the network so data stays live.
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// Focus (or open) the app when a notification is tapped.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// Background push — fires even when the app is fully closed, as long as the
// service worker is still registered (sent by push-worker/, not the page).
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'Regional Weather Centre', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'Regional Weather Centre';
  const opts = {
    body: data.body || '',
    tag: data.tag || 'rwc-push',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    requireInteraction: true
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
