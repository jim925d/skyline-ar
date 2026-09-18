# Skyline AR

Names the peaks on the horizon and draws them over the live camera. A browser-based take on
[PeakFinder](https://www.peakfinder.com/).

No build step, no dependencies, no server code. Plain files, one origin: the app is `index.html`,
the DEM raycaster is `horizon-worker.js`, offline is `sw.js` plus `manifest.webmanifest`.

## Run it

The camera and compass require a secure context, so `file://` will not work on iOS.

```bash
# local
python3 -m http.server 8000     # then use a tunnel (ngrok/cloudflared) for https on a phone

# hosted
# GitHub Pages: Settings -> Pages -> Deploy from branch -> main / root
```

Open the https URL on a phone, tap **Start camera**, grant camera, motion and location.

Add it to the home screen and it installs as a standalone app and works with no signal. The app
shell, the peak list and the raycaster are precached; terrain tiles live in their own cache that an
app update will not evict; horizon profiles and any peaks pulled from OpenStreetMap are kept in
IndexedDB. Build a horizon while you have signal and it will be there on the ridge.

## What works

- **Camera mode** — rear camera fills the screen, peak labels and ridge outlines project over it
- **Drawing mode** — synthetic panorama, no camera needed, drag to pan and pinch to zoom
- **Geodesy** — great-circle distance, true bearing, apparent altitude with earth curvature and
  atmospheric refraction (k = 0.13)
- **Occlusion** — a 2880-bin skyline buffer filled near-to-far; peaks below the running max are
  marked hidden and drop out of the labels
- **Orientation** — full 3x3 rotation matrix from `deviceorientation` (alpha/beta/gamma), so labels
  track through tilt and roll, not just heading. iOS uses `webkitCompassHeading` for true north;
  Android uses `deviceorientationabsolute`
- **Projection** — pinhole model. Focal length derives from the video track's native long edge and
  the configured field of view, then scales by the `object-fit: cover` factor so the crop is handled
- **Manual alignment** — drag to nudge heading and pitch, pinch to adjust FOV. Phone magnetometers
  drift several degrees and no browser exposes true lens FOV, so this is required, not optional
- **FOV calibration** — two-point solve. One dragged point is degenerate: moving a single peak is
  explained equally well by a focal-length change or a heading/pitch offset. So step 1 drags a peak
  anywhere in frame to pin the optical axis (solves heading and pitch), and step 2 drags a peak out
  near the edge to pin the scale — with the axis fixed, screen radius from centre is exactly
  proportional to focal length, so `f_new = f_old * r_wanted / r_drawn`
- **Persistence** — FOV, heading offset, pitch offset, units, range, minimum angle and the sun
  toggle survive a reload, under `skyline-ar.prefs.v1`. Values are clamped and type-checked on read
- **Sun** — NOAA-simplified solar position, full day arc plus current disc
- **Peak data** — ~56 hand-entered Colorado summits, plus an Overpass (OpenStreetMap) loader for
  anywhere else, with a copy-paste fallback when the browser blocks the request

## Terrain

Tap **Build horizon** in Setup and the app raycasts a real digital elevation model around your
viewpoint: ~163 terrain tiles, 3600 azimuths, curvature and refraction applied at every step. The
resulting azimuth→altitude profile drives both the drawn silhouette and peak occlusion. It is cached
in IndexedDB against a rounded viewpoint, so it survives a reload and works offline.

Until you build one — or on a viewpoint with no cached profile and no signal — the app falls back to
the old heuristic: ridge outlines synthesized from summit points with an angular half-width of
`max(700m, distance * 0.11)`, and a 2880-bin skyline buffer for occlusion. Between two summits, that
fallback is guessing. It is kept deliberately, because it is what makes the app work with no network
and no camera.

## Tile source for DEM raycasting

Decided after testing both from a real browser origin:

- **Copernicus GLO-30** (`copernicus-dem-30m.s3.amazonaws.com`) — **rejected.** Cross-origin fetch
  fails outright, and the Range request needed for COG reads forces a preflight the bucket does not
  answer. Server-side only, so it would mean a proxy.
- **USGS SRTM 1-arcsecond** — **rejected.** Needs an EarthData login.
- **AWS Terrain Tiles** (`elevation-tiles-prod`, Tilezen/Mapzen) — **chosen.** Anonymous, no key,
  CORS clean. The "terrarium" tiles are plain PNGs where
  `elevation = (R·256 + G + B/256) − 32768`, so `createImageBitmap` plus `OffscreenCanvas` decodes
  them inside the worker with no parsing code and no dependency. Over CONUS the source is USGS 3DEP.

Sampled against the hand-entered peaks: Longs Peak 4345.8 m (listed 4346), Mount Elbert 4396.1 m
(listed 4401), Denver Civic Center 1596.8 m (listed 1609, and the tile is bare earth). Tiles run
75–135 KB and 60–230 ms.

Attribution required: **U.S. Geological Survey** for CONUS, plus a Tilezen/Mapzen credit.

Two changes from the original plan:

1. **Cap the radius at ~200 km, not 300.** Curvature drop at 300 km is about 6,165 m, so a 4,400 m
   summit is thousands of metres below the horizon from Denver — `apparentAlt` already says nothing
   past ~200 km can be visible. Fetching 300 km of tiles buys invisible terrain.
2. **Vary zoom by distance** — z12 inside 30 km, z10 to 100 km, z9 to 200 km, fetching the annulus
   rather than a bounding box. Roughly 200 tiles per viewpoint instead of 6,400 at uniform z12.

## How the raycaster works

All of it in `horizon-worker.js`, off the main thread.

1. Work out which tiles the three distance rings need, as annuli rather than bounding boxes
2. Fetch them six at a time, decode with `createImageBitmap` + `OffscreenCanvas`, store as `Int16`
   metres (a metre is far finer than the horizon maths can use, and it halves the footprint)
3. Build one step ladder shared by every ray, precomputing the spherical direct-geodesic constants
   that depend only on distance — so a sample costs one `atan2`, one `log` and a `sqrt`, not a full
   geodesic solve
4. March each of 3600 azimuths, sampling elevation bilinearly, tracking the maximum *tangent* of the
   apparent altitude rather than the angle: `atan2` is monotonic so the argmax is identical, and it
   saves a transcendental on every one of ~7 million samples
5. Emit azimuth → altitude plus the coordinate and distance of each horizon point, transferring the
   typed arrays rather than copying them

Measured from Denver Civic Center: 163 tiles in 2.1 s, 3600 azimuths in 1.6 s on a desktop.

The value finally emitted goes back through the same `atan2` form `apparentAlt()` uses, and
`test/horizon.test.mjs` pins the two against each other — they live in different files and would
otherwise drift, and a silent drift means the silhouette and the occlusion disagree with nothing to
show for it.

### Accuracy

From Denver Civic Center the profile puts Longs Peak at 1.64° and 78.5 km, with the horizon point at
40.2562 / −105.6175 against the table's 40.2549 / −105.6151 — about 180 m out on a 30 m grid.
`apparentAlt` on the table's own figures says 1.70°; the 0.06° gap is the DEM reading the summit a
few metres lower than the survey.

## Tests

```bash
node test/projection.test.mjs   # geometry, calibration, prefs, render paths
node test/horizon.test.mjs      # tile indexing, step ladder, raycast vs apparentAlt
node test/offline.test.mjs      # precache list, manifest, no external scripts
```

`test/harness.mjs` pulls the real `<script>` out of `index.html` and runs it against a minimal DOM
stub, so the tests exercise shipped code rather than a transcription of the maths. They cover the
camera basis in portrait and landscape against hand-solved device poses, the calibration solvers
(plant a known FOV, perturb it, check it is recovered), prefs round-tripping and corrupt storage.

Node only. The app itself still has no dependencies and no build step.

**What the tests do not tell you.** They verify the derivation is self-consistent. They cannot tell
you whether a particular handset's magnetometer is honest, whether the camera's real FOV matches the
solve, or whether you dragged the marker onto the right summit. Those are field tests.

## Known unknowns

- **Landscape rotation sign** — *resolved.* W3C defines `screen.orientation.angle` as the degrees
  the screen is rotated counter-clockwise from natural, so at `angle = 90` device +Y points to the
  user's left and +X points up, giving `right = cosA·dX − sinA·dY` with no flip. Hardcoded, test
  covered, escape hatch removed.
- **Default FOV (67°)** — still the shipped default, but now solvable in the field rather than
  eyeballed. Calibrate once and it persists.
- **Android absolute orientation** — *handled.* Orientation events are tagged by source; if none are
  absolute 2.5 s after permission, the app switches to the drawn panorama and says why rather than
  drifting silently. "Use the camera anyway" keeps a warning bar across the overlay.

## Layout

Everything is in `index.html`:

| Section | What it holds |
| --- | --- |
| `PEAKS` / `VIEWS` | Peak and viewpoint data |
| geodesy block | distance, bearing, apparentAlt, sunPos |
| `compute()` | Per-viewpoint peak resolution, occlusion, ridge polylines |
| `basisFromOrientation()` | Device orientation to world-frame camera basis |
| horizon block | IndexedDB cache, worker lifecycle, profile lookup |
| calibration block | Two-point FOV and axis solve |
| `projectAR()` | Pinhole projection with alignment offsets |
| `drawAR()` / `drawPanorama()` | The two render paths |

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app — data, geodesy, projection, both render paths, UI |
| `horizon-worker.js` | DEM tile fetch and horizon raycast, off the main thread |
| `sw.js` | Service worker: app shell, terrain tile cache |
| `manifest.webmanifest` | Home-screen install |
| `test/` | Node-only checks, not shipped to the browser |

## License

MIT
