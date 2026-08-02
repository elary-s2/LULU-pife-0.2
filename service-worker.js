const CACHE_NAME = 'lulu-pife-cache-v2';
const CARD_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const CARD_VALUES = ['ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/assets/js/Sortable.min.js',
  '/manifest.json',
  '/assets/icons/icon.png',
  '/assets/cards/back/1780335294916.png',
  ...CARD_SUITS.flatMap((suit) => CARD_VALUES.map((value) => `/assets/cards/${suit}/${value}_of_${suit}.svg`))
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

function networkFirst(request) {
  return fetch(request).then((networkResponse) => {
    if (networkResponse && networkResponse.status === 200) {
      const responseClone = networkResponse.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
    }
    return networkResponse;
  }).catch(() => caches.match(request));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestURL = new URL(event.request.url);

  if (requestURL.pathname.startsWith('/socket.io')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('', {
        headers: { 'Content-Type': 'application/javascript' }
      }))
    );
    return;
  }

  if (requestURL.origin === location.origin) {
    const shouldUseNetworkFirst = ['/', '/index.html', '/style.css', '/script.js', '/assets/js/Sortable.min.js'].includes(requestURL.pathname);
    if (shouldUseNetworkFirst) {
      event.respondWith(
        networkFirst(event.request).then((response) => response || caches.match(event.request) || caches.match('/index.html'))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        return cachedResponse || fetch(event.request).then((networkResponse) => {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return networkResponse;
        }).catch(() => caches.match('/index.html'));
      })
    );
  }
});
