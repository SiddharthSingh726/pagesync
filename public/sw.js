/* PageSync service worker — lets the app open with no internet.
   PDFs and notes are stored separately by the app (IndexedDB); this only caches the app itself. */
const VERSION = 'pagesync-v3.2.2'; // keep in sync with APP_VERSION in js/backend.js
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.105.4/+esm';
const SHELL = [
  './',
  'index.html',
  'viewer.html',
  'login.html',
  'reset.html',
  'check.html',
  'config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'css/style.css',
  'js/common.js',
  'js/backend.js',
  'js/library.js',
  'js/viewer.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  SUPABASE_JS,
];

// A new version waits until a page says it's a safe moment to switch (see registerServiceWorker).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch((e) => console.warn('SW skip', url, e)))))

  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const sameOrigin = (url) => url.origin === self.location.origin;
const isCdn = (url) => url.hostname === 'cdn.jsdelivr.net';

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

/** Try the network (so updates show up), but fall back to the cache quickly on bad connections. */
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  const isPage = request.mode === 'navigate';
  const key = isPage ? new URL(request.url).pathname : request;
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  network.catch(() => {});
  try {
    const res = await Promise.race([network, new Promise((resolve) => setTimeout(resolve, 4000, null))]);
    if (res) return res;
  } catch {
    /* offline */
  }
  const hit =
    (await cache.match(request, { ignoreSearch: true })) ||
    (isPage && (await cache.match(key))) ||
    (isPage && (await cache.match('index.html')));
  return hit || network; // nothing cached: keep waiting for the network
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isCdn(url)) return event.respondWith(cacheFirst(request));
  if (!sameOrigin(url)) return; // Supabase API, storage, realtime: always live
  if (url.pathname.includes('/vendor/')) return event.respondWith(cacheFirst(request));
  event.respondWith(networkFirst(request));
});
