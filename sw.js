// ================================================================
// HELIX INDUSTRIES — Service Worker  (sw.js)  v2
// ================================================================
//
// KEY FIX: iOS "Add to Home Screen" 404 problem
// -----------------------------------------------
// When iOS launches a PWA from the Home Screen, it requests the
// start_url from manifest.json. If the file isn't cached AND the
// network request fails (or path is wrong), you get a 404 blank screen.
//
// This service worker:
//   1. Pre-caches index.html on install so it's ALWAYS available offline
//   2. Intercepts ALL navigation requests and serves index.html from
//      cache — so even if the URL is slightly wrong, the app loads
//   3. Never caches Google Apps Script API calls (always live data)
//   4. Caches Google Fonts for fast loading
//
// DEPLOYMENT — all files go in the SAME folder on GitHub Pages:
//   index.html        ← the dashboard (renamed from helix-dashboard.html)
//   sw.js             ← this file
//   manifest.json     ← PWA manifest
//   icon-192.png      ← app icon
//   icon-512.png      ← app icon
//
// VERSIONING: bump CACHE_VERSION after any update to index.html
// ================================================================

var CACHE_VERSION = 'helix-v2';
var CACHE_NAME    = 'helix-app-' + CACHE_VERSION;

// Files to cache on install — index.html is the critical one
var PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── INSTALL ──────────────────────────────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        // Cache each file individually so one failure doesn't block all
        return Promise.all(
          PRECACHE_URLS.map(function(url) {
            return cache.add(url).catch(function(err) {
              console.warn('[SW] Could not pre-cache:', url, err.message);
            });
          })
        );
      })
      .then(function() {
        // Activate immediately — don't wait for old tabs to close
        return self.skipWaiting();
      })
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
              // Delete any old helix cache that isn't the current version
              return key.startsWith('helix-app-') && key !== CACHE_NAME;
            })
            .map(function(key) { return caches.delete(key); })
        );
      })
      .then(function() {
        // Take control of all open pages immediately
        return self.clients.claim();
      })
  );
});

// ── FETCH ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  var req = event.request;
  var url = req.url;

  // ── 1. Google Apps Script API calls — NEVER cache ──────────────
  // These are the live data JSONP fetches. Always go to the network.
  if (url.indexOf('script.google.com') !== -1 ||
      url.indexOf('script.googleusercontent.com') !== -1) {
    event.respondWith(fetch(req));
    return;
  }

  // ── 2. Google Fonts — cache-first ──────────────────────────────
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

  // ── 3. Navigation requests (page loads) — cache-first ──────────
  // This is the KEY fix for the iOS 404 problem.
  // When iOS launches the PWA, it makes a navigation request for
  // the start_url. We intercept it and serve index.html from cache.
  // This works even if the URL has changed slightly or the network
  // is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        // Try to serve index.html from cache first
        return cache.match('./index.html').then(function(cached) {
          if (cached) {
            // Serve cached version immediately, update in background
            fetch(req).then(function(response) {
              if (response && response.status === 200) {
                cache.put('./index.html', response.clone());
              }
            }).catch(function() {}); // Ignore network errors
            return cached;
          }
          // Not in cache yet — fetch from network and cache it
          return fetch(req).then(function(response) {
            if (response && response.status === 200) {
              cache.put('./index.html', response.clone());
            }
            return response;
          }).catch(function() {
            // Truly offline and nothing cached — return a minimal error page
            return new Response(
              '<h2 style="font-family:sans-serif;padding:20px">Helix Dashboard is offline. Please connect to the internet and try again.</h2>',
              { headers: { 'Content-Type': 'text/html' } }
            );
          });
        });
      })
    );
    return;
  }

  // ── 4. All other requests — network first, cache fallback ───────
  event.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return fetch(req)
        .then(function(response) {
          if (response && response.status === 200 && req.method === 'GET') {
            cache.put(req, response.clone());
          }
          return response;
        })
        .catch(function() {
          return cache.match(req);
        });
    })
  );
});
