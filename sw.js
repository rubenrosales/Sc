// Offline support: app shell is cache-first; schedule data is network-first with cache fallback.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/parsers.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/schedule.json', 'data/details.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  const dataFile = (url.pathname.match(/\/data\/(schedule|details)\.json$/) || [])[0];
  if (dataFile) {
    const key = dataFile.slice(1); // "data/schedule.json" | "data/details.json"
    // Network first, but never wait more than 4s on bad conference WiFi.
    e.respondWith((async () => {
      const cached = async () => (await caches.match(key, { ignoreSearch: true, cacheName: DATA })) || caches.match(key, { ignoreSearch: true });
      const net = fetch(e.request).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(DATA).then((c) => c.put(key, copy)); }
        return r;
      });
      net.catch(() => {});
      const timeout = new Promise((res) => setTimeout(res, 4000));
      try {
        const r = await Promise.race([net, timeout]);
        if (r && r.ok) return r;
      } catch { /* offline */ }
      return (await cached()) || net;
    })());
    return;
  }

  // Stale-while-revalidate for the shell so updates arrive on the next open.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => {
      const net = fetch(e.request)
        .then((r) => {
          if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
          return r;
        })
        .catch(() => cached || caches.match('index.html'));
      return cached || net;
    }),
  );
});
