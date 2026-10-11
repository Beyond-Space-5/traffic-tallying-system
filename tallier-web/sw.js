const CACHE_NAME = 'traffic-tally-v1';
const ASSETS_TO_CACHE = [
  '/tallier/pages/tallier_login.html',
  '/tallier/pages/tallier_tally.html',
  '/tallier/pages/tallier_analytics.html',
  '/tallier/css/tallier_login.css',
  '/tallier/css/tallier_analytics.css'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});