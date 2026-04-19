// ================================================================
// HELIX INDUSTRIES — Service Worker  (sw.js)  v3
// ================================================================
//
// Caching strategy:
//   config.json  → Network-first, cache fallback
//                  MUST always be fresh so URL updates propagate.
//   index.html   → Stale-while-revalidate (serve cache, update bg)
//   Google Fonts → Cache-first (never changes)
//   GAS API      → Network-only (live data, never cache)
//   Everything else → Network-first, cache fallback
//
// BUMP CACHE_VERSION after any update to index.html
// ================================================================

var CACHE_VERSION = 'helix-v3';
var CACHE_NAME    = 'helix-app-' + CACHE_VERSION;

var PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // config.json is NOT pre-cached — it must always be fetched fresh
];

// ── INSTALL ──────────────────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return Promise.all(
          PRECACHE_URLS.map(function(url) {
            return cache.add(url).catch(function(err) {
              console.warn('[SW] Pre-cache failed for', url, err.message);
            });
          })
        );
      })
      .then(function() { return self.skipWaiting(); })
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys
            .filter(function(key) {
              return key.startsWith('helix-app-') && key !== CACHE_NAME;
            })
            .map(function(key) { return caches.delete(key); })
        );
      })
      .then(function() { return self.clients.claim(); })
  );
});

// ── FETCH ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = req.url;

  // ── 1. GAS API calls — NEVER cache ─────────────────────────────
  if (url.indexOf('script.google.com') !== -1 ||
      url.indexOf('script.googleusercontent.com') !== -1) {
    event.respondWith(fetch(req));
    return;
  }

  // ── 2. config.json — Network-first, cache fallback ─────────────
  // CRITICAL: config.json must always be fetched from network so that
  // GAS URL updates in GitHub propagate to all users immediately.
  // Only fall back to cache if the network is completely unavailable.
  if (url.indexOf('config.json') !== -1) {
    event.respondWith(
      fetch(req)
        .then(function(response) {
          if (response && response.status === 200) {
            // Update the cache with the fresh version
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(req, clone);
            });
          }
          return response;
        })
        .catch(function() {
          // Offline — serve cached version (user gets last known URL)
          return caches.match(req).then(function(cached) {
            return cached || new Response('{}', {
              headers: { 'Content-Type': 'application/json' }
            });
          });
        })
    );
    return;
  }

  // ── 3. Google Fonts — Cache-first ──────────────────────────────
  if (url.indexOf('fonts.googleapis.com') !== -1 ||
      url.indexOf('fonts.gstatic.com') !== -1) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(req).then(function(cached) {
          if (cached) return cached;
          return fetch(req).then(function(response) {
            if (response && response.status === 200) {
              cache.put(req, response.clone());
            }
            return response;
          });
        });
      })
    );
    return;
  }

  // ── 4. Navigation (page loads) — Stale-while-revalidate ────────
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match('./index.html').then(function(cached) {
          // Update in background
          var networkFetch = fetch(req).then(function(response) {
            if (response && response.status === 200) {
              cache.put('./index.html', response.clone());
            }
            return response;
          }).catch(function() { return null; });

          return cached || networkFetch;
        });
      })
    );
    return;
  }

  // ── 5. Everything else — Network-first, cache fallback ─────────
  event.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return fetch(req)
        .then(function(response) {
          if (response && response.status === 200 && req.method === 'GET') {
            cache.put(req, response.clone());
          }
          return response;
        })
        .catch(function() { return cache.match(req); });
    })
  );
});
