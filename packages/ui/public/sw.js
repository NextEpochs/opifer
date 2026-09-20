/* Opifer service worker: the app shell is cached so the interface opens
   instantly and survives a flaky connection; the API is never cached, and
   live data always comes from the server. */
const SHELL = "opifer-shell-v1";
const BASE = new URL("./", self.location.href).pathname;
const SHELL_URLS = [BASE, `${BASE}index.html`, `${BASE}manifest.webmanifest`, `${BASE}icons/icon-192.png`, `${BASE}icons/icon-512.png`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // API and events: always the network.
  if (url.pathname.startsWith(`${BASE}v1/`)) return;
  // Hashed assets: cache first (their names change with every build).
  if (url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(
      caches
        .open(SHELL)
        .then((cache) => cache.match(event.request).then((hit) => hit ?? fetch(event.request).then((response) => (cache.put(event.request, response.clone()), response)))),
    );
    return;
  }
  // The shell: network first, cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match(`${BASE}index.html`))),
  );
});
