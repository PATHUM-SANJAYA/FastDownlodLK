const CACHE_NAME = 'fastdl-lk-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/contact.html',
    '/privacy.html',
    '/terms.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    '/assets/icon.svg',
    // External CDNs to cache optionally (fonts, tailwind, fontawesome, alpine)
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://unpkg.com/aos@2.3.1/dist/aos.css',
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js',
    'https://unpkg.com/aos@2.3.1/dist/aos.js'
];

// Install Event
self.addEventListener('install', (event) => {
    // Skip waiting ensures the new SW takes over immediately
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching App Shell');
            // We use no-cors to aggressively cache external assets without failing the whole cache process
            const cachePromises = STATIC_ASSETS.map(url => {
                return fetch(url, { mode: 'no-cors' })
                    .then(response => {
                        if (response.ok || response.type === 'opaque') {
                            return cache.put(url, response);
                        }
                    })
                    .catch(err => console.log('[SW] Failed to cache:', url, err));
            });
            return Promise.all(cachePromises);
        })
    );
});

// Activate Event
self.addEventListener('activate', (event) => {
    // Take control of all clients immediately
    event.waitUntil(self.clients.claim());
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Fetch Event (Cache First, Network Fallback strategy)
self.addEventListener('fetch', (event) => {
    // Exclude API requests from caching
    if (event.request.url.includes('/api/')) {
        return; // Let the browser handle the network request naturally
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            // Fallback to network
            return fetch(event.request)
                .then((networkResponse) => {
                    // Don't cache bad responses
                    if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                        return networkResponse;
                    }

                    // Dynamically cache new assets (optional, but good for fonts/images spawned later)
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });

                    return networkResponse;
                })
                .catch(() => {
                    // Offline fallback
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                });
        })
    );
});
