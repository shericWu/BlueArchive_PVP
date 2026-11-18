// Service Worker：快取 App 檔案以便離線使用。
// 每次修改 App 檔案後，請把 VERSION 加一，手機才會抓到新版。
const VERSION = 'v1.0.0';
const CACHE = `ba-pvp-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'db.js',
  'students.js',
  'util.js',
  'style.css',
  'vendor/dexie.mjs',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'data/students.json',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);

  // 學生名單：先試網路（才拿得到更新），失敗再用快取
  if (url.pathname.endsWith('/data/students.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) await cache.put('data/students.json', res.clone());
        return res;
      } catch {
        return (await cache.match('data/students.json')) || Response.error();
      }
    })());
    return;
  }

  // 其他檔案：快取優先；頁面導覽一律回傳 index.html
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') return (await cache.match('index.html')) || fetch(req);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});
