// ╔══════════════════════════════════════════════════════════╗
// ║  ICEWATCH — Service Worker                               ║
// ║  Cache App Shell + tuiles carte offline                  ║
// ╚══════════════════════════════════════════════════════════╝

const SW_VERSION   = 'icewatch-sw-v1';
const SHELL_CACHE  = `${SW_VERSION}-shell`;
const TILES_CACHE  = 'icewatch-tiles-v1';   // partagé avec le code in-page

const APP_SHELL = [
  './ICEWATCHNT.html',
  './icewatch-manifest.webmanifest',
  './pwa-icon-192.png',
  './pwa-icon-512.png',
  // Leaflet (CDN) — mis en cache lors de la première visite
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ── INSTALL : mise en cache de l'app shell ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL).catch(err => {
        // Des ressources CDN peuvent échouer sans connexion au premier install
        console.warn('[SW] Shell partiel (certaines CDN non disponibles):', err);
      }))
  );
  self.skipWaiting();
});

// ── ACTIVATE : nettoyage des anciens caches ─────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k !== SHELL_CACHE && k !== TILES_CACHE)
        .map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// ── FETCH : stratégie par type de ressource ─────────────────
self.addEventListener('fetch', event => {
  const req  = event.request;
  const url  = new URL(req.url);

  if (req.method !== 'GET') return;

  // 1. Navigation principale → App Shell (offline fallback)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./ICEWATCHNT.html'))
    );
    return;
  }

  // 2. Tuiles cartographiques → Cache d'abord, puis réseau
  const isTile = isTileRequest(url);
  if (isTile) {
    event.respondWith(
      caches.open(TILES_CACHE).then(cache =>
        cache.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req, { mode: 'cors' }).then(resp => {
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
          }).catch(() => new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // 3. App Shell & ressources statiques → Cache d'abord
  if (url.origin === self.location.origin || isCDN(url)) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(resp => {
          if (resp && resp.ok) {
            caches.open(SHELL_CACHE).then(c => c.put(req, resp.clone()));
          }
          return resp;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // 4. Reste (Overpass, OpenAIP, APIs) → Réseau uniquement, pas de cache
});

// ── HELPERS ─────────────────────────────────────────────────
function isTileRequest(url) {
  const tileHosts = [
    'basemaps.cartocdn.com',
    'tile.opentopomap.org',
    'tile.openstreetmap.org',
    'arcgisonline.com',
    'tiles.openaip.net',
    'nwy-tiles-api.prod.newaydata.com',
  ];
  return tileHosts.some(h => url.hostname.includes(h));
}

function isCDN(url) {
  const cdnHosts = [
    'unpkg.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdn.jsdelivr.net',
  ];
  return cdnHosts.some(h => url.hostname.includes(h));
}

// ── MESSAGE : préchargement manuel de tuiles ─────────────────
// Déclenché depuis la page lors du téléchargement offline
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CACHE_TILES') {
    const urls = event.data.urls || [];
    caches.open(TILES_CACHE).then(cache => {
      let n = 0;
      const total = urls.length;
      const chunks = chunkArray(urls, 8); // 8 en parallèle max

      function processChunk(i) {
        if (i >= chunks.length) {
          event.source && event.source.postMessage({ type: 'CACHE_DONE', cached: n, total });
          return;
        }
        Promise.allSettled(
          chunks[i].map(url =>
            cache.match(url).then(hit => {
              if (hit) { n++; return; }
              return fetch(url, { mode: 'cors' }).then(r => {
                if (r && r.ok) { cache.put(url, r); n++; }
              }).catch(() => {});
            })
          )
        ).then(() => {
          event.source && event.source.postMessage({ type: 'CACHE_PROGRESS', cached: n, total });
          processChunk(i + 1);
        });
      }
      processChunk(0);
    });
  }

  if (event.data && event.data.type === 'CLEAR_TILES') {
    caches.delete(TILES_CACHE).then(() => {
      event.source && event.source.postMessage({ type: 'TILES_CLEARED' });
    });
  }
});

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
