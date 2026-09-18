# Skyline AR

Names the peaks on the horizon and draws them over the live camera. A browser-based take on
[PeakFinder](https://www.peakfinder.com/).

Single self-contained HTML file. No build step, no dependencies, no server code.

## Run it

The camera and compass require a secure context, so `file://` will not work on iOS.

```bash
# local
python3 -m http.server 8000     # then use a tunnel (ngrok/cloudflared) for https on a phone

# hosted
# GitHub Pages: Settings -> Pages -> Deploy from branch -> main / root
```

Open the https URL on a phone, tap **Start camera**, grant camera, motion and location.

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
- **Sun** — NOAA-simplified solar position, full day arc plus current disc
- **Peak data** — ~56 hand-entered Colorado summits, plus an Overpass (OpenStreetMap) loader for
  anywhere else, with a copy-paste fallback when the browser blocks the request

## What it fakes

Ridge outlines are synthesized from summit points using an angular half-width heuristic
(`max(700m, distance * 0.11)`). The real app raycasts a digital elevation model, so its skyline is
actual terrain. Between two summits, this app is guessing.

## The real fix: DEM raycasting

1. Fetch Copernicus GLO-30 or SRTM 1-arcsecond tiles covering a radius around the viewpoint
2. For each of ~3600 azimuths, march outward in ~30 m steps, sampling elevation bilinearly
3. Track the running max apparent altitude, applying curvature and refraction at each step
4. Emit a horizon profile: azimuth -> altitude, plus the source coordinate of each horizon point
5. Match OSM peaks to horizon points to decide visibility and label placement
6. Cache profiles in IndexedDB keyed by rounded viewpoint so it works offline

Precompute server-side or in a Web Worker. A 300 km radius at 30 m is too much to raycast on the
main thread.

## Known unknowns

- **Landscape rotation sign** — untested on a real device. If labels sit sideways in landscape, hit
  "Flip landscape" in Setup. Whichever is right, hardcode it and delete the button.
- **Default FOV (67°)** — a guess at the iPhone main wide lens. Calibrate against a known peak and
  set the real number.
- **Android absolute orientation** — some devices report `absolute: false` on `deviceorientation`
  and the overlay will drift. Needs a fallback path.

## Layout

Everything is in `index.html`:

| Section | What it holds |
| --- | --- |
| `PEAKS` / `VIEWS` | Peak and viewpoint data |
| geodesy block | distance, bearing, apparentAlt, sunPos |
| `compute()` | Per-viewpoint peak resolution, occlusion, ridge polylines |
| `basisFromOrientation()` | Device orientation to world-frame camera basis |
| `projectAR()` | Pinhole projection with alignment offsets |
| `drawAR()` / `drawPanorama()` | The two render paths |

## License

MIT
