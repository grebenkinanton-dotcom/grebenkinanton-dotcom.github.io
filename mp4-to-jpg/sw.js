// App-shell cache: the app opens instantly and works offline after the first visit.
// Network first so updates arrive right away; cache is the fallback.
const CACHE = "mp4-to-jpg-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "worker.js", "vendor/mp4box.all.min.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "favicon.ico"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mp4-to-jpg-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
