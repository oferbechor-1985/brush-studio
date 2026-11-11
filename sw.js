// Bump VERSION on every release: the new worker installs in the background and the app offers "update now".
const VERSION = 'v62';
const CACHE = 'brush-studio-' + VERSION;
const FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('brush-studio-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Pages and the manifest: network first (fresh code whenever online), cache as the offline fallback.
  const isNav = e.request.mode === 'navigate', isManifest = /\/manifest\.webmanifest$/.test(new URL(e.request.url).pathname);
  if (isNav || isManifest || /\/index\.html$/.test(new URL(e.request.url).pathname)) {
    // The page is cached only under ./index.html and the manifest only under its own URL (v49 and older stored the manifest over the page).
    const key = isManifest ? e.request : './index.html';
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
      const type = res.headers.get('content-type') || '';
      if (res.ok && (isManifest || /text\/html/.test(type))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok && (new URL(e.request.url).origin === location.origin || /fonts\.(googleapis|gstatic)\.com/.test(e.request.url))) {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  })));
});
