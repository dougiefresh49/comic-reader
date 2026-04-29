/* Comic Reader service worker — offline asset cache.
 *
 * The reader's heavy assets are pages (WebP), audio (MP3), and the
 * audio library (MP3). We cache them per issue so kids can read on
 * a plane without burning data, and the dialogue/sfx still play.
 *
 * Strategy:
 *   - Install: claim clients immediately, no precache.
 *   - Fetch: cache-first for assets matching CACHEABLE_PATTERNS;
 *     network-first for everything else (HTML / API).
 *   - Population: the page calls postMessage({type:'PREFETCH', urls})
 *     to download a list ahead of going offline.
 */

const CACHE_NAME = "comic-reader-v1";
const CACHEABLE_PATTERNS = [
  /\/storage\/v1\/object\/public\/comic-pages\//,
  /\/storage\/v1\/object\/public\/comic-audio\//,
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  const cacheable = CACHEABLE_PATTERNS.some((p) => p.test(url));
  if (!cacheable) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const fresh = await fetch(event.request);
        if (fresh && fresh.ok && fresh.type === "basic") {
          cache.put(event.request, fresh.clone()).catch(() => {});
        } else if (fresh && fresh.ok && fresh.type === "cors") {
          // Supabase storage responses are CORS responses; we can still
          // cache them with put() as long as they're successful.
          cache.put(event.request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        // No cache hit + offline → 504. The UI shows a friendly fallback.
        return new Response("Offline and not in cache", {
          status: 504,
          statusText: "Offline",
        });
      }
    })(),
  );
});

// Prefetch helper triggered by the OfflineDownload button.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "PREFETCH") return;
  const urls = Array.isArray(data.urls) ? data.urls : [];
  const port = event.ports[0];
  void prefetch(urls, port);
});

async function prefetch(urls, port) {
  const cache = await caches.open(CACHE_NAME);
  let done = 0;
  let failed = 0;
  // Don't hammer Supabase — limit to 6 concurrent.
  const limit = 6;
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const url = urls[idx++];
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (res.ok) await cache.put(url, res.clone());
        else failed++;
      } catch {
        failed++;
      }
      done++;
      port?.postMessage({ done, total: urls.length, failed });
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  port?.postMessage({ done, total: urls.length, failed, complete: true });
  port?.close();
}
