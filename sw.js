/* LiftLog service worker — precaches the app shell + data.json, cache-first, versioned. */
'use strict';

const VERSION = 'liftlog-v202609221020';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './features.js',
  './strong.js',
  './templates.js',
  './nutrition.js',
  './body.js',
  './data.json',
  './foods.json',
  './guides.json',
  './quotes.json',
  './marcus.png',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

/* The page asks the controlling worker which build it is. Reading cache names
   from the page reported a half-installed cache's version while old code was
   still running, so the stamp said "latest" over a stale app. */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'version' && event.ports && event.ports[0])
    event.ports[0].postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      /* cache:'reload' bypasses the browser's HTTP cache. GitHub Pages sends
         max-age=600, so without it a worker installed within ten minutes of a
         visit precached the PREVIOUS build's files under the NEW version name
         -- the build stamp claimed the latest build while old code ran. */
      .then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
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

/* On localhost the VERSION constant never changes (only the deploy step stamps
   it), so a cached asset would shadow every local edit and make code changes
   look like they had no effect. Bypass the cache entirely during development;
   production keeps full offline caching. */
const DEV = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

self.addEventListener('fetch', event => {
  if (DEV) return;                            // straight to network while developing
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
  // This is what serves the 194 exercise-guide frames under ./media/exercises/.
  // They are ~5.9 MB in total and are deliberately NOT in ASSETS: precaching
  // them would put the whole set on the install critical path for a screen most
  // launches never open. The first view of an exercise fetches its two frames
  // and this branch keeps them from then on, so the guide works offline after
  // it has been looked at once.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      if (cached) {
        fetch(req, { cache: 'no-cache' }).then(res => {
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
