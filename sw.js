// Offline-Unterstützung: App-Dateien werden zwischengespeichert.
// Bei jeder Änderung an der App CACHE hochzählen.
const CACHE = 'spesen-si-v2';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './ocr.js',
  './manifest.webmanifest',
  './vendor/pdf-lib.esm.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Erst aus dem Zwischenspeicher antworten, im Hintergrund aktualisieren.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      // Große Bibliotheken ändern sich nie – nicht jedes Mal neu laden.
      if (cached && req.url.includes('/vendor/')) return cached;
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
