
const CACHE_NAME = 'anot-v4'
const PRECACHE_URLS = ['/favicon.png', '/brand/anot-logo.png']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {})),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    )
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET') { return }

  // 1. Never cache API responses — they may contain PHI.
  if (url.pathname.includes('/api/')) {
    return
  }

  // 2. Navigation / HTML requests: ALWAYS NETWORK-FIRST
  // This guarantees fresh index.html is loaded immediately on deploy.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(() => caches.match(request)),
    )
    return
  }

  // 3. Static assets with content hashes: Cache-First
  if (url.pathname.includes('/assets/') || /\.(js|css|png|jpg|jpeg|svg|webp|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response && response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })),
    )
  }
})

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-audio-queue') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'SYNC_QUEUE',
            action: 'uploadQueuedAudio',
          })
        })
      }),
    )
  }
})
