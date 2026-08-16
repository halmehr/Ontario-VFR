/* ON VFR service worker — offline app shell, data, and map tiles */
const SHELL = "onvfr-shell-v1";
const TILES = "onvfr-tiles-v1";
const DATA  = "onvfr-data-v1";

const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"
];
const DATA_URLS = ["./airspace-on.json", "./airports-on.json"];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    // individual adds so one failure doesn't abort the whole install
    await Promise.all(SHELL_URLS.map(u => shell.add(u).catch(() => {})));
    const data = await caches.open(DATA);
    await Promise.all(DATA_URLS.map(u => data.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![SHELL, TILES, DATA].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isTile = u =>
  /tile\.openstreetmap\.org/.test(u) ||
  /tile\.opentopomap\.org/.test(u) ||
  /tiles\.arcgis\.com/.test(u);
const isRadar = u => /geo\.weather\.gc\.ca/.test(u);

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = req.url;

  // radar: always live, never cached (stale radar is worse than none)
  if (isRadar(url)) return;

  // map tiles: cache-first, then network, then transparent placeholder
  if (isTile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
        return res;
      } catch (err) {
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"></svg>',
          { headers: { "Content-Type": "image/svg+xml" } });
      }
    })());
    return;
  }

  // data files: cache-first, refresh in background when online
  if (DATA_URLS.some(d => url.endsWith(d.replace("./", "")))) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      const hit = await c.match(req);
      if (hit) { fetch(req).then(r => r.ok && c.put(req, r)).catch(() => {}); return hit; }
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  // app shell and everything else: network-first, fall back to cache
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && new URL(url).origin === location.origin) {
        const c = await caches.open(SHELL); c.put(req, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      return caches.match("./index.html");
    }
  })());
});

/* bulk tile pre-cache driven by the page */
self.addEventListener("message", async e => {
  const d = e.data || {};
  if (d.cmd !== "precache" || !Array.isArray(d.urls)) return;
  const c = await caches.open(TILES);
  let done = 0, failed = 0;
  const q = d.urls.slice();
  const workers = new Array(6).fill(0).map(async () => {
    while (q.length) {
      const u = q.shift();
      try {
        if (await c.match(u)) { done++; }
        else {
          const r = await fetch(u, { mode: "no-cors" });
          await c.put(u, r.clone());
          done++;
        }
      } catch (err) { failed++; }
      if ((done + failed) % 25 === 0 || !q.length) {
        const cl = await self.clients.matchAll();
        cl.forEach(x => x.postMessage({ type: "precache", done, failed, total: d.urls.length }));
      }
    }
  });
  await Promise.all(workers);
  const cl = await self.clients.matchAll();
  cl.forEach(x => x.postMessage({ type: "precache", done, failed, total: d.urls.length, finished: true }));
});
