/* LiftLog service worker — precaches the app shell + data.json, cache-first, versioned. */
'use strict';

const VERSION = 'liftlog-v202608221345';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never touch cross-origin (e.g. YouTube links)

  // Navigations: serve the shell so the PWA always opens offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(cached => cached || fetch(req))
    );
    return;
  }

  // Everything else same-origin: cache-first, refresh the cache copy in the background.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      if (cached) {
        fetch(req).then(res => {
          if (res && res.ok) caches.open(VERSION).then(c => c.put(req, res));
        }).catch(() => { /* offline — cached copy already served */ });
        return cached;
      }
      return fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
