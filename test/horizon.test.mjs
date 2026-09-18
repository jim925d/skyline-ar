/* Checks on the DEM raycaster that do not need the network.
   Run: node test/horizon.test.mjs

   The one thing worth pinning hardest is that the worker's altitude formula is
   identical to the main thread's apparentAlt(). They live in different files and
   will drift otherwise, and a silent drift means the drawn silhouette and the
   peak occlusion disagree by a fraction of a degree with nothing to show for it.

   What this cannot check is the tile fetch or the real terrain. That was
   verified separately against live tiles: from Denver Civic Center the profile
   puts Longs Peak at 1.64 deg and 78.5 km, with the horizon point 40.2562 /
   -105.6175 against the table's 40.2549 / -105.6151 -- about 180 m out on a
   30 m grid. 163 tiles, 3600 azimuths, 1.6 s. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

function loadWorker() {
  const src = readFileSync(join(here, "..", "horizon-worker.js"), "utf8");
  const sandbox = { console, Math, Map, Set, Int16Array, Int8Array, Float32Array, Float64Array,
                    Promise, Array, Object, Number, Date, Infinity, NaN,
                    OffscreenCanvas: class {}, createImageBitmap: () => {}, fetch: () => {} };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__w={RINGS,MIN_R,TILE,tiles,missing,lonLatToTile,tileCentre,haversine,tilesForRing,sampleElev,buildLadder,castRay};",
                  ctx, { filename: "horizon-worker.js" });
  return vm.runInContext("__w", ctx);
}

/* the shipped apparentAlt, copied out of index.html rather than retyped */
function appApparentAlt() {
  const html = readFileSync(join(here, "..", "index.html"), "utf8");
  const line = html.match(/const apparentAlt=([^;]+);/)[1];
  return new Function("R", "KREF", "R2D", `return ${line}`)(6371000, 0.13, 180 / Math.PI);
}

let pass = 0, fail = 0;
const near = (a, b, tol, what) => { const o = Math.abs(a - b) <= tol; o ? pass++ : fail++;
  console.log(`${o ? "ok  " : "FAIL"}  ${what}  (got ${(+a).toFixed(6)}, want ${(+b).toFixed(6)} +/-${tol})`); };
const ok = (c, what) => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"}  ${what}`); };

const w = loadWorker();
const apparentAlt = appApparentAlt();

console.log("\n-- tile indexing --");
{
  for (const [lat, lon, z] of [[39.7392, -104.9903, 12], [40.2549, -105.6151, 12], [-33.9, 151.2, 9], [60.1, 24.9, 10]]) {
    const [fx, fy] = w.lonLatToTile(lon, lat, z);
    const c = w.tileCentre(Math.floor(fx), Math.floor(fy), z);
    const halfTile = 360 / (1 << z) / 2;
    ok(Math.abs(c[0] - lon) <= halfTile * 1.01,
       `tileCentre round-trips longitude at z${z}, ${lat.toFixed(1)}/${lon.toFixed(1)}`);
    ok(Math.abs(c[1] - lat) <= halfTile * 1.5,
       `tileCentre round-trips latitude at z${z}, ${lat.toFixed(1)}/${lon.toFixed(1)}`);
  }
  // the y axis must increase southward, or every tile lookup is mirrored
  const north = w.lonLatToTile(-105, 45, 10)[1], south = w.lonLatToTile(-105, 35, 10)[1];
  ok(south > north, "mercator tile y increases southward");
}

console.log("\n-- ring coverage --");
{
  const lat = 39.7392, lon = -104.9903;
  let total = 0;
  for (const ring of w.RINGS) {
    const list = w.tilesForRing(lat, lon, ring);
    total += list.length;
    const resM = 156543.03392 * Math.cos(lat * Math.PI / 180) / (1 << ring.z);
    const slack = resM * w.TILE * 0.75;
    const bad = list.filter(([z, x, y]) => {
      const c = w.tileCentre(x, y, z);
      const d = w.haversine(lat, lon, c[1], c[0]);
      return d > ring.outer + slack + 1 || d < ring.inner - slack - 1;
    });
    ok(list.length > 0, `ring z${ring.z} (${ring.inner / 1000}-${ring.outer / 1000} km) asks for ${list.length} tiles`);
    ok(bad.length === 0, `ring z${ring.z} asks for no tile outside its annulus`);
  }
  ok(total > 80 && total < 400, `whole viewpoint is ${total} tiles — the right order of magnitude`);
}

console.log("\n-- the step ladder --");
{
  const L = w.buildLadder(39.7392);
  let expect = 0;
  for (const r of w.RINGS) expect += Math.ceil((r.outer - Math.max(r.inner, w.MIN_R)) / r.step);
  near(L.n, expect, 1, "ladder length matches the ring definitions");
  ok(L.rad[0] >= w.MIN_R, "the ladder starts past the ground at your feet");
  near(L.rad[L.n - 1], 200000, 300, "the ladder stops at the 200 km cap");
  for (let i = 1; i < L.n; i++) if (L.rad[i] <= L.rad[i - 1]) { ok(false, "ladder radii increase"); break; }
  ok(L.rad[L.n - 1] > L.rad[0], "ladder radii increase");
  // the curvature term must be the same one apparentAlt uses
  for (const i of [0, 500, 1200, L.n - 1]) {
    const r = L.rad[i];
    near(L.drop[i], r * r * (1 - 0.13) / (2 * 6371000), 1e-9,
         `curvature+refraction drop at ${(r / 1000).toFixed(1)} km matches apparentAlt's term`);
  }
}

console.log("\n-- worker altitude == apparentAlt --");
{
  /* Synthetic terrain: every tile lookup returns the same constant-height
     plateau, so the ray's best hit is the nearest step and the expected answer
     is exactly apparentAlt(r, H, h0). */
  const plateau = H => { const a = new Int16Array(w.TILE * w.TILE).fill(H); w.tiles.get = () => a; };

  const CURV = (1 - 0.13) / (2 * 6371000);
  for (const [H, h0] of [[3000, 1600], [4300, 1610], [2000, 4000], [1500, 1500]]) {
    plateau(H);
    const L = w.buildLadder(39.7392);
    const hit = w.castRay(270, 39.7392, -104.9903, h0, L);
    ok(hit !== null, `flat plateau at ${H} m from ${h0} m returns a hit`);
    near(hit.alt, apparentAlt(hit.dist, H, h0), 1e-9,
         `worker altitude equals apparentAlt(${(hit.dist).toFixed(0)} m, ${H}, ${h0})`);

    /* Where the horizon of a level plateau sits depends on which side of it you
       are standing. Looking up at ground above you, the nearest point subtends
       the largest angle. Looking down from above it, the apparent altitude is
       -(h0-H)/r - CURV*r, which is maximised at r = sqrt((h0-H)/CURV) -- the
       far edge where the earth curves away, not your own feet. Both are the
       physically right answer and the raycast should find each of them. */
    if (H >= h0) {
      near(hit.dist, L.rad[0], 1e-9, `plateau ${H} m is above ${h0} m: horizon is the nearest point`);
    } else {
      const want = Math.sqrt((h0 - H) / CURV);
      near(hit.dist, want, 400,
           `plateau ${H} m is below ${h0} m: horizon is the curvature limit at ${(want / 1000).toFixed(0)} km`);
      // and it really is a maximum, not an artefact of the step ladder
      const better = [hit.dist * 0.5, hit.dist * 1.5].every(r => apparentAlt(r, H, h0) <= hit.alt + 1e-12);
      ok(better, "...and no nearer or further point on that plateau stands higher");
    }
  }

  // and the source coordinate should be at the ray's bearing and distance
  plateau(3000);
  const L = w.buildLadder(39.7392);
  for (const az of [0, 90, 180, 270, 317.3]) {
    const hit = w.castRay(az, 39.7392, -104.9903, 1600, L);
    const d = w.haversine(39.7392, -104.9903, hit.lat, hit.lon);
    near(d, hit.dist, 1.0, `horizon point at az ${az} is ${hit.dist.toFixed(0)} m away, as reported`);
  }
}

console.log("\n-- no data --");
{
  w.tiles.get = () => undefined;
  const L = w.buildLadder(39.7392);
  ok(w.castRay(270, 39.7392, -104.9903, 1600, L) === null,
     "a ray with no tiles under it returns null rather than a fabricated horizon");
  ok(w.sampleElev(Math.sin(39.7 * Math.PI / 180), -105, 12) !== w.sampleElev(Math.sin(39.7 * Math.PI / 180), -105, 12),
     "sampleElev returns NaN where there is no tile");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
