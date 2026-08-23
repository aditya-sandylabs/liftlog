/* LiftLog service worker — precaches the app shell + data.json, cache-first, versioned. */
'use strict';

const VERSION = 'liftlog-v202608231216';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.json',
  './quotes.json',
  './marcus.png',
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

  // Navigations: network-first so a deployed fix actually arrives, falling back
  // to the cached shell when offline. Cache-first here meant the app could sit
  // on a stale build indefinitely.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(c => c || Response.error()))
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
