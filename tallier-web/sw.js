const CACHE_NAME = 'traffic-tally-v1';
const ASSETS_TO_CACHE = [
  '/tallier-web/pages/tallier_login.html',
  '/tallier-web/pages/tallier_tally.html',
  '/tallier-web/pages/tallier_analytics.html',
  '/tallier-web/css/tallier_login.css',
  '/tallier-web/css/tallier_analytics.css'
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