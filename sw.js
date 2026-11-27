const CACHE_NAME = 'ethio-lyrics-cache-v36';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/themes.css',
  './js/app.js',
  './js/catalog-schema.js',
  './js/components/elm-logo.js',
  './js/utils/sanitize.js',
  './js/recommendation-engine.js',
  './js/party-sync.js',
  './js/local-sync-service.js',
  './js/webrtc-p2p.js',
  './js/camera-scanner.js',
  './js/qr-code.js',
  './js/libs/qrcode.min.js',
  './js/libs/jsqr.min.js',
  './js/player.js',
  './js/lyrics-parser.js',
  './js/palette.js',
  './js/particles.js',
  './js/storage.js',
  './js/lrc-editor.js',
  './js/theme-manager.js',
  './js/firebase-service.js',
  './assets/weleta_cover.jpg',
  './brand/elm-icon.svg',
  './brand/elm-default-cover.svg',
  './brand/elm-logo-horizontal.svg',
  './brand/elm-logo-stacked.svg',
  './brand/icon-192x192.png',
  './brand/icon-512x512.png',
  './brand/icon-maskable-512x512.png',
  './brand/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('Some assets could not be precached:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin HTTP(S) GET requests (never intercept Google/Firebase, apis.google.com, R2, /api/, or /ws)
  if (
    !url.protocol.startsWith('http') ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Network-first for HTML navigation so deployed updates take effect immediately
  if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached, and revalidate in background for local files
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
            }
          })
          .catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
