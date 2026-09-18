/* Skyline AR — DEM horizon raycaster.
 *
 * Runs off the main thread. Fetches terrain tiles around a viewpoint, marches
 * ~3600 azimuths outward, and emits an azimuth-to-altitude horizon profile plus
 * the source coordinate of every horizon point.
 *
 * Tile source: AWS Terrain Tiles (Tilezen/Mapzen), bucket elevation-tiles-prod.
 * Anonymous, no key, CORS clean, and the "terrarium" tiles are plain PNGs:
 *
 *     elevation = (R * 256 + G + B / 256) - 32768   metres
 *
 * so createImageBitmap plus OffscreenCanvas decodes them with no parsing code
 * and no dependency. Copernicus GLO-30 was the first choice and is unusable
 * from a static page: its bucket refuses cross-origin reads and the Range
 * request a COG needs forces a preflight it does not answer.
 *
 * Attribution: U.S. Geological Survey (3DEP/SRTM over CONUS), Tilezen/Mapzen.
 *
 * No imports. Same origin, no build step.
 */

"use strict";

const R = 6371000;          // matches the main thread's sphere
const KREF = 0.13;          // refraction coefficient, matches apparentAlt()
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const TILE = 256;
const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/* Zoom ladder by distance. Ground resolution is 156543.03 * cos(lat) / 2^z
   metres per pixel, so at 40 deg north z12 is about 29 m — the 30 m step the
   raycast wants — and the outer rings drop to resolutions that still resolve a
   ridge line at that range. Sampling finer than the DEM buys nothing.

   The outer radius is 200 km rather than 300. Curvature drop at 300 km is
   d^2 (1-k) / 2R = about 6165 m, so a 4400 m summit sits thousands of metres
   below the horizon from a 1600 m viewpoint. There is nothing out there to
   see, and fetching it is 4000 wasted tiles. */
const RINGS = [
  { inner: 0,      outer: 30000,  z: 12, step: 30  },
  { inner: 30000,  outer: 100000, z: 10, step: 120 },
  { inner: 100000, outer: 200000, z: 9,  step: 240 },
];

const MIN_R = 60;           // ignore the ground at your feet, as compute() does
const FETCH_CONCURRENCY = 6;
const TILE_CACHE_MAX = 400;

/* ------------------------------------------------------------------ tiles */

/* Decoded tiles, keyed "z/x/y". Int16 metres: terrarium carries 1/256 m but a
   metre is far finer than the horizon maths can use, and Int16 halves the
   footprint to 128 KB a tile. */
const tiles = new Map();
const missing = new Set();

function cacheTile(key, data) {
  tiles.set(key, data);
  while (tiles.size > TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
}

let canvas = null, cctx = null;
function decodeCanvas() {
  if (!canvas) {
    canvas = new OffscreenCanvas(TILE, TILE);
    cctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  return cctx;
}

async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tiles.has(key) || missing.has(key)) return;
  const n = 1 << z;
  if (y < 0 || y >= n) { missing.add(key); return; }       // off the top/bottom of the world
  const wx = ((x % n) + n) % n;                            // wrap the antimeridian

  let res;
  try {
    res = await fetch(TILE_URL(z, wx, y), { mode: "cors", cache: "force-cache" });
  } catch (e) {
    missing.add(key);                                      // offline, or the tile is not there
    return;
  }
  if (!res.ok) { missing.add(key); return; }

  const bmp = await createImageBitmap(await res.blob());
  const cx = decodeCanvas();
  cx.clearRect(0, 0, TILE, TILE);
  cx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = cx.getImageData(0, 0, TILE, TILE).data;

  const out = new Int16Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    // (R*256 + G + B/256) - 32768, rounded to the metre
    out[i] = Math.round(px[j] * 256 + px[j + 1] + px[j + 2] / 256) - 32768;
  }
  cacheTile(key, out);
}

/* Which tiles a ring needs. Bounding box of the outer radius, then keep the
   tiles whose centre falls inside the annulus with a tile-diagonal of slack. */
function tilesForRing(lat, lon, ring) {
  const n = 1 << ring.z;
  const mPerDegLat = 111320;
  const mPerDegLon = Math.max(1, 111320 * Math.cos(lat * D2R));
  const dLat = ring.outer / mPerDegLat;
  const dLon = ring.outer / mPerDegLon;

  const [x0, y1] = lonLatToTile(lon - dLon, lat - dLat, ring.z);
  const [x1, y0] = lonLatToTile(lon + dLon, lat + dLat, ring.z);

  const resM = 156543.03392 * Math.cos(lat * D2R) / n;
  const slack = resM * TILE * 0.75;                        // generous half-diagonal

  const out = [];
  for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(n - 1, Math.floor(y1)); ty++) {
    for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
      const c = tileCentre(tx, ty, ring.z);
      const d = haversine(lat, lon, c[1], c[0]);
      if (d <= ring.outer + slack && d >= ring.inner - slack) out.push([ring.z, tx, ty]);
    }
  }
  return out;
}

function lonLatToTile(lon, lat, z) {
  const n = 1 << z, r = lat * D2R;
  return [(lon + 180) / 360 * n,
          (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
}
function tileCentre(x, y, z) {
  const n = 1 << z;
  const lon = (x + 0.5) / n * 360 - 180;
  const m = Math.PI * (1 - 2 * (y + 0.5) / n);
  const lat = Math.atan(Math.sinh(m)) * R2D;
  return [lon, lat];
}
function haversine(la1, lo1, la2, lo2) {
  const p1 = la1 * D2R, p2 = la2 * D2R, dp = (la2 - la1) * D2R, dl = (lo2 - lo1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* Bilinear elevation sample. Takes sin(lat) and lon in radians, because the
   ray marcher has those already and converting back and forth is the hot path.
   Returns NaN where no tile covers the point. */
function sampleElev(sinLat, lonDeg, z) {
  const n = 1 << z;
  // mercator y without a tan() call: tan(lat) = sinLat / sqrt(1 - sinLat^2),
  // and asinh(t) = log(t + sqrt(t*t + 1))
  const c = Math.sqrt(1 - sinLat * sinLat);
  if (c < 1e-9) return NaN;
  const t = sinLat / c;
  const my = Math.log(t + Math.sqrt(t * t + 1));
  const fy = (1 - my / Math.PI) / 2 * n;
  const fx = (lonDeg + 180) / 360 * n;

  const gx = fx * TILE, gy = fy * TILE;                    // global pixel coords
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const dx = gx - x0, dy = gy - y0;

  const e00 = px(x0,     y0,     z, n);
  const e10 = px(x0 + 1, y0,     z, n);
  const e01 = px(x0,     y0 + 1, z, n);
  const e11 = px(x0 + 1, y0 + 1, z, n);
  if (e00 !== e00) return NaN;
  const a = e00 + (e10 - e00) * dx;
  const b = e01 + (e11 - e01) * dx;
  return a + (b - a) * dy;
}

function px(gx, gy, z, n) {
  const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
  if (ty < 0 || ty >= n) return NaN;
  const wx = ((tx % n) + n) % n;
  const t = tiles.get(`${z}/${wx}/${ty}`);
  if (!t) return NaN;
  return t[(gy - ty * TILE) * TILE + (gx - tx * TILE)];
}

/* ------------------------------------------------------------- raycasting */

/* Step ladder shared by every ray: radius, ring index, and the spherical
   direct-geodesic constants that depend only on distance. */
function buildLadder(lat) {
  const sinLat1 = Math.sin(lat * D2R), cosLat1 = Math.cos(lat * D2R);
  const rs = [];
  for (const ring of RINGS) {
    const start = Math.max(ring.inner, MIN_R);
    for (let r = start; r < ring.outer; r += ring.step) rs.push([r, ring.z]);
  }
  const n = rs.length;
  const rad = new Float64Array(n), zoom = new Int8Array(n);
  const A = new Float64Array(n), B = new Float64Array(n), cosD = new Float64Array(n);
  const drop = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rs[i][0], d = r / R;
    rad[i] = r; zoom[i] = rs[i][1];
    const sd = Math.sin(d), cd = Math.cos(d);
    A[i] = sinLat1 * cd;            // sin(lat2) = A + B*cos(theta)
    B[i] = cosLat1 * sd;
    cosD[i] = cd;
    drop[i] = r * r * (1 - KREF) / (2 * R);   // same curvature+refraction term as apparentAlt()
  }
  return { rad, zoom, A, B, cosD, drop, sinLat1, n };
}

/* One ray. Tracks the maximum tangent of the apparent altitude rather than the
   angle itself: atan2 is monotonic, so the argmax is identical and it saves a
   transcendental on every one of ~7 million samples. The value finally emitted
   is put back through the same atan2 form apparentAlt() uses, so the numbers
   agree with the main thread exactly. */
function castRay(azDeg, lat, lon, h0, L) {
  const th = azDeg * D2R, cosT = Math.cos(th), sinT = Math.sin(th);
  let bestTan = -Infinity, bestI = -1;
  for (let i = 0; i < L.n; i++) {
    const sinLat2 = L.A[i] + L.B[i] * cosT;
    const h = sampleElev(sinLat2, lon + Math.atan2(sinT * L.B[i], L.cosD[i] - L.sinLat1 * sinLat2) * R2D, L.zoom[i]);
    if (h !== h) continue;                      // no tile here
    const tan = (h - h0 - L.drop[i]) / L.rad[i];
    if (tan > bestTan) { bestTan = tan; bestI = i; }
  }
  if (bestI < 0) return null;
  const r = L.rad[bestI];
  const sinLat2 = L.A[bestI] + L.B[bestI] * cosT;
  return {
    alt: Math.atan2((r * bestTan), r) * R2D,    // identical to apparentAlt()'s form
    dist: r,
    lat: Math.asin(sinLat2) * R2D,
    lon: lon + Math.atan2(sinT * L.B[bestI], L.cosD[bestI] - L.sinLat1 * sinLat2) * R2D,
  };
}

/* ---------------------------------------------------------------- message */

let cancelled = false;

async function build(job) {
  const { id, lat, lon, h0, azSteps } = job;
  cancelled = false;

  // --- tiles
  let want = [];
  for (const ring of RINGS) want = want.concat(tilesForRing(lat, lon, ring));
  want = want.filter(([z, x, y]) => !tiles.has(`${z}/${x}/${y}`) && !missing.has(`${z}/${x}/${y}`));

  let done = 0;
  post({ type: "progress", id, phase: "tiles", done: 0, total: want.length });
  let cursor = 0;
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async () => {
    while (cursor < want.length && !cancelled) {
      const [z, x, y] = want[cursor++];
      await fetchTile(z, x, y);
      done++;
      if (done % 5 === 0 || done === want.length)
        post({ type: "progress", id, phase: "tiles", done, total: want.length });
    }
  }));
  if (cancelled) return post({ type: "cancelled", id });

  if (tiles.size === 0) {
    return post({ type: "error", id, message: "No elevation tiles could be fetched. Check the connection." });
  }

  // --- raycast
  const n = azSteps || 3600, dAz = 360 / n;
  const alt = new Float32Array(n), srcLat = new Float32Array(n),
        srcLon = new Float32Array(n), srcDist = new Float32Array(n);
  const L = buildLadder(lat);

  post({ type: "progress", id, phase: "cast", done: 0, total: n });
  for (let i = 0; i < n; i++) {
    if (cancelled) return post({ type: "cancelled", id });
    const hit = castRay(i * dAz, lat, lon, h0, L);
    if (hit) { alt[i] = hit.alt; srcLat[i] = hit.lat; srcLon[i] = hit.lon; srcDist[i] = hit.dist; }
    else { alt[i] = NaN; srcDist[i] = NaN; }
    if ((i & 255) === 0) post({ type: "progress", id, phase: "cast", done: i, total: n });
  }

  post({
    type: "done", id,
    profile: { lat, lon, h0, n, dAz, alt, srcLat, srcLon, srcDist,
               tiles: tiles.size, created: Date.now() },
  }, [alt.buffer, srcLat.buffer, srcLon.buffer, srcDist.buffer]);
}

function post(msg, transfer) { transfer ? self.postMessage(msg, transfer) : self.postMessage(msg); }

self.onmessage = async ev => {
  const job = ev.data;
  if (job.type === "cancel") { cancelled = true; return; }
  if (job.type !== "horizon") return;
  try { await build(job); }
  catch (e) { post({ type: "error", id: job.id, message: String(e && e.message || e) }); }
};
