// Bump when the list of precached files changes. Updated file contents are
// picked up automatically by the network-first fetch handler below.
const CACHE_NAME = 'noise-generator-v5';
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './icons/web-app-manifest-192x192.png',
    './icons/web-app-manifest-512x512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-96x96.png',
    './icons/favicon.ico',
    './icons/favicon.svg'
];

// Install event: cache all the core assets, bypassing the HTTP cache so a new
// service worker never precaches stale files. Activate immediately instead of
// waiting for every open tab to close.
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache.map(url => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

// Activate event: clean up old caches and take control of open pages
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(cacheNames => Promise.all(
                cacheNames
                    .filter(cacheName => cacheName !== CACHE_NAME)
                    .map(cacheName => caches.delete(cacheName))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch event: network first so deployments show up straight away, keeping the
// cache fresh for offline use; fall back to the cache when offline.
self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        fetch(request, { cache: 'no-cache' })
            .then(response => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => caches.match(request, { ignoreSearch: true }))
    );
});
