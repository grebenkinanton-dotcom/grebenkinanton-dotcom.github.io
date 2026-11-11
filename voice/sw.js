// 1) App-shell cache so the app opens instantly and works offline after first use.
// 2) Adds cross-origin isolation headers (GitHub Pages can't set them) so the
//    speech engine can use several CPU cores, which makes it much faster.
// Voice models are cached separately by the speech engines.
const CACHE = "read-aloud-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "worker.js", "worker-piper.js", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => /^read-aloud-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Network first (fresh updates), fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return isolate(res);
    }).catch(() => caches.match(e.request).then(isolate))
  );
});
