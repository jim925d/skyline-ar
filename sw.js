/* Skyline AR — service worker.
 *
 * The use case is standing on a ridge with one bar, so "offline" is the normal
 * case rather than the failure case. Three caches, three strategies:
 *
 *   shell    the app itself. Network-first on navigation so a push actually
 *            reaches the phone, cache fallback so a dead signal still opens it.
 *            Stale-while-revalidate for the rest, so the worker script and the
 *            icons load instantly and update quietly in the background.
 *
 *   tiles    terrain PNGs from AWS. Cache-first and never revalidated: a DEM
 *            tile is immutable for our purposes, and re-fetching 160 of them on
 *            a mountain is exactly what this is meant to avoid. FIFO-trimmed.
 *
 *   nothing  everything else falls through to the network untouched.
 *
 * Horizon profiles and OSM peaks live in IndexedDB, not here — they are derived
 * data, not responses.
 */

const VERSION    = "v1";
const SHELL      = `skyline-shell-${VERSION}`;
const TILES      = "skyline-tiles-v1";      // deliberately not version-bumped
const TILE_MATCH = "elevation-tiles-prod";
const TILE_MAX   = 1400;                    // ~8 viewpoints' worth

const SHELL_FILES = [
  "./",
  "./index.html",
  "./horizon-worker.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", ev => {
  ev.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // addAll is all-or-nothing; one 404 would leave the app with no offline copy
    await Promise.all(SHELL_FILES.map(f =>
      c.add(new Request(f, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("skyline-shell-") && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", ev => {
  if (ev.data === "skipWaiting") self.skipWaiting();
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function tileFirst(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) { c.put(req, res.clone()); trim(c, TILE_MAX); }
  return res;
}

async function shellRevalidate(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match(req);
  const net = fetch(req).then(res => {
    if (res && res.ok) c.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function navigateFirst(req) {
  const c = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res && res.ok) c.put("./index.html", res.clone());
    return res;
  } catch (e) {
    return (await c.match(req)) || (await c.match("./index.html")) || Response.error();
  }
}

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.href.includes(TILE_MATCH)) return ev.respondWith(tileFirst(req));
  if (req.mode === "navigate")       return ev.respondWith(navigateFirst(req));
  if (url.origin === self.location.origin) return ev.respondWith(shellRevalidate(req));
  // Overpass and anything else: straight to the network. Peaks pulled from OSM
  // are persisted to IndexedDB by the app, which is a better offline story than
  // caching a 2 MB JSON response nobody can index.
});
