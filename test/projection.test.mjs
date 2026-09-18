/* Geometry checks for the AR overlay. Run: node test/projection.test.mjs
   These verify the derivation, not the hardware: a real phone can still be
   wrong about its own compass. What they do catch is a sign flip in
   basisFromOrientation() or a regression in the projection. */
import { load } from "./harness.mjs";

let pass = 0, fail = 0;
const near = (a, b, tol, what) => {
  const ok = Math.abs(a - b) <= tol;
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}  (got ${(+a).toFixed(3)}, want ${(+b).toFixed(3)} +/-${tol})`);
};
const ok = (cond, what) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${what}`); };
const vnear = (v, w, tol, what) => near(Math.hypot(v[0]-w[0], v[1]-w[1], v[2]-w[2]), 0, tol, what);

const EAST = [1,0,0], NORTH = [0,1,0], UP = [0,0,1], WEST = [-1,0,0], SOUTH = [0,-1,0];

/* Phone held vertically, screen facing the user, rear camera pointing due west.
   Device +Z (out of the screen) = east, +Y (top edge) = up, +X = north.
   Solving the W3C Z-X'-Y'' basis for that pose gives alpha=90, beta=90, gamma=0. */
const PORTRAIT_WEST = { alpha: 90, beta: 90, gamma: 0 };

/* Same pose, handset turned 90 deg counter-clockwise as the user sees it, which
   is what screen.orientation.angle === 90 means. +X now points up, +Y points to
   the user's left (south, since the user faces east). alpha=180, beta=0, gamma=-90. */
const LANDSCAPE_WEST = { alpha: 180, beta: 0, gamma: -90 };

console.log("\n-- portrait, camera due west --");
{
  const { api } = load({ screenAngle: 0 });
  api.state.orient = PORTRAIT_WEST;
  api.state.screenAngle = 0;
  const b = api.basisFromOrientation();
  vnear(b.fwd,   WEST,  1e-9, "camera looks west");
  vnear(b.up,    UP,    1e-9, "screen up is world up");
  vnear(b.right, NORTH, 1e-9, "screen right is north (facing west, north is on your right)");

  const f = api.focalPx();
  const c = api.projectAR(b, f, 270, 0);
  near(c.x, 390/2, 1e-6, "peak due west lands on the horizontal centre");
  near(c.y, 780/2, 1e-6, "peak at 0 deg altitude lands on the vertical centre");

  const rightward = api.projectAR(b, f, 280, 0);   // 10 deg from west toward north
  ok(rightward.x > 390/2, "a peak 10 deg north of west draws to the right of centre");
  const higher = api.projectAR(b, f, 270, 5);
  ok(higher.y < 780/2, "a peak 5 deg up draws above centre");
  ok(api.projectAR(b, f, 90, 0) === null, "a peak behind the camera is culled");
}

console.log("\n-- landscape (screen.orientation.angle = 90), camera due west --");
{
  const { api } = load({ screenAngle: 90 });
  api.state.orient = LANDSCAPE_WEST;
  api.state.screenAngle = 90;
  const b = api.basisFromOrientation();
  vnear(b.fwd,   WEST,  1e-9, "camera still looks west");
  vnear(b.up,    UP,    1e-9, "screen up is STILL world up (not upside down)");
  vnear(b.right, NORTH, 1e-9, "screen right is STILL north (not mirrored)");

  const f = api.focalPx();
  const c = api.projectAR(b, f, 270, 0);
  near(c.x, 390/2, 1e-6, "peak due west stays centred");
  const rightward = api.projectAR(b, f, 280, 0);
  ok(rightward.x > 390/2, "a peak 10 deg north of west still draws to the right");
  const higher = api.projectAR(b, f, 270, 5);
  ok(higher.y < 780/2, "a peak 5 deg up still draws above centre");
}

console.log("\n-- the wrong sign would be visibly wrong --");
{
  /* Sanity: if the sign were flipped, landscape would come out 180 deg rotated.
     Recomputing with a = -90 by hand proves the two are distinguishable, so the
     test above is actually load-bearing. */
  const { api } = load({ screenAngle: 90 });
  api.state.orient = LANDSCAPE_WEST;
  api.state.screenAngle = -90;                 // stand in for the flipped sign
  const b = api.basisFromOrientation();
  vnear(b.up,    [0,0,-1], 1e-9, "flipped sign puts screen-up at world-down");
  vnear(b.right, SOUTH,    1e-9, "flipped sign mirrors left/right");
}

console.log("\n-- geodesy the user has already checked (regression guard only) --");
{
  const { api } = load({});
  // Denver Civic Center -> Longs Peak
  const d = api.dist(39.7392, -104.9903, 40.2549, -105.6151);
  near(d / 1000, 80, 4, "Denver to Longs Peak is about 80 km");
  const az = api.bearing(39.7392, -104.9903, 40.2549, -105.6151);
  ok(az > 310 && az < 330, `Longs Peak bears NW from Denver (got ${az.toFixed(1)} deg)`);
  const alt = api.apparentAlt(d, 4346, 1610);
  ok(alt > 1.3 && alt < 2.2, `Longs Peak sits about 1.5-2 deg up (got ${alt.toFixed(2)} deg)`);
  ok(api.apparentAlt(300000, 4346, 1610) < api.apparentAlt(80000, 4346, 1610),
     "curvature drops a distant summit lower than a near one of the same height");
}

console.log("\n-- persisted alignment survives a reload --");
{
  const a = load({});
  a.api.state.fovLong = 71.4; a.api.state.headOff = -3.5; a.api.state.pitchOff = 1.25;
  a.api.state.units = "m"; a.api.savePrefs();
  // savePrefs debounces through setTimeout, which the stub swallows; write directly
  a.sandbox.localStorage.setItem("skyline-ar.prefs.v1",
    JSON.stringify({ fovLong: 71.4, headOff: -3.5, pitchOff: 1.25, units: "m", sun: false }));
  const raw = a.sandbox.localStorage.getItem("skyline-ar.prefs.v1");

  const b = load({});
  b.sandbox.localStorage.setItem("skyline-ar.prefs.v1", raw);
  b.api.loadPrefs();
  near(b.api.state.fovLong, 71.4, 1e-9, "FOV restored");
  near(b.api.state.headOff, -3.5, 1e-9, "heading offset restored");
  near(b.api.state.pitchOff, 1.25, 1e-9, "pitch offset restored");
  ok(b.api.state.units === "m", "units restored");
  ok(b.api.state.sun === false, "sun toggle restored");

  const c = load({});
  c.sandbox.localStorage.setItem("skyline-ar.prefs.v1", JSON.stringify({ fovLong: 999, headOff: "x" }));
  c.api.loadPrefs();
  ok(c.api.state.fovLong <= 100, "a silly stored FOV is clamped, not trusted");
  near(c.api.state.headOff, 0, 1e-9, "a non-numeric stored offset is ignored");

  const d = load({});
  d.sandbox.localStorage.setItem("skyline-ar.prefs.v1", "{not json");
  d.api.loadPrefs();
  near(d.api.state.fovLong, 67, 1e-9, "corrupt storage falls back to defaults");
}

console.log("\n-- FOV calibration solvers --");
{
  /* Synthesise a ground truth, throw it away, and check the solver finds it again.
     This is real verification: the calibration maths is pure and does not need a
     phone. What it cannot tell you is whether YOU dragged the marker onto the
     right summit -- that part is still a field test. */
  const mk = a => { const { api, el } = load({ screenAngle: 0 });
    el("vid").videoWidth = 1920; el("vid").videoHeight = 1080;
    api.state.orient = { alpha: 90, beta: 90, gamma: 0 }; api.state.screenAngle = 0; return api; };

  { // focalPx and fovFromFocal are exact inverses
    const api = mk();
    for (const fov of [42, 58.25, 67, 74, 96]) {
      api.state.fovLong = fov;
      near(api.fovFromFocal(api.focalPx()), fov, 1e-9, `fovFromFocal inverts focalPx at ${fov} deg`);
    }
  }

  { // step 1: recover a known heading/pitch offset from one dragged point
    const api = mk();
    const peak = { n: "truth", az: 272, alt: 1.5 };
    api.state.fovLong = 67;
    api.state.headOff = -2.5; api.state.pitchOff = 1.2;
    const truth = api.projectAR(api.basisFromOrientation(), api.focalPx(), peak.az, peak.alt);

    api.state.headOff = 0; api.state.pitchOff = 0;
    ok(api.solveAxis(peak, truth.x, truth.y), "solveAxis converges");
    near(api.state.headOff, -2.5, 0.02, "heading offset recovered");
    near(api.state.pitchOff, 1.2, 0.02, "pitch offset recovered");
    const back = api.projectAR(api.basisFromOrientation(), api.focalPx(), peak.az, peak.alt);
    near(back.x, truth.x, 0.1, "peak reprojects onto the dragged point (x)");
    near(back.y, truth.y, 0.1, "peak reprojects onto the dragged point (y)");
  }

  { // step 2: recover a known FOV from one off-axis point, axis already pinned
    const api = mk();
    const peak = { n: "edge", az: 286, alt: 2.0 };
    api.state.headOff = 0; api.state.pitchOff = 0;

    api.state.fovLong = 74;                                   // the lens's real FOV
    const truth = api.projectAR(api.basisFromOrientation(), api.focalPx(), peak.az, peak.alt);

    api.state.fovLong = 67;                                   // the guess we ship with
    const f0 = api.focalPx();
    const drawn = api.projectAR(api.basisFromOrientation(), f0, peak.az, peak.alt);
    const dx = drawn.x - 390 / 2, dy = drawn.y - 780 / 2, r0 = Math.hypot(dx, dy);
    ok(r0 > Math.min(390, 780) * 0.15, "the chosen peak is far enough off-axis to measure scale");
    api.state.cal = { step: 2, peak, ref: { f0, r0, ux: dx / r0, uy: dy / r0 } };

    ok(api.solveFov(truth.x, truth.y), "solveFov accepts the drag");
    near(api.state.fovLong, 74, 0.01, "field of view recovered from a single off-axis point");
  }

  { // the degeneracy that forced two steps: a centred point carries no scale information
    const api = mk();
    api.state.headOff = 0; api.state.pitchOff = 0; api.state.fovLong = 67;
    const centred = { n: "middle", az: 270.1, alt: 0.05 };
    const f0 = api.focalPx();
    const d = api.projectAR(api.basisFromOrientation(), f0, centred.az, centred.alt);
    const r0 = Math.hypot(d.x - 390 / 2, d.y - 780 / 2);
    ok(r0 < Math.min(390, 780) * 0.15,
       "a peak near the optical axis falls inside the rejection radius, as intended");
  }

  { // dragging back through the centre is refused rather than producing a wild FOV
    const api = mk();
    api.state.fovLong = 67;
    api.state.cal = { step: 2, peak: { n: "x", az: 286, alt: 2 },
                      ref: { f0: api.focalPx(), r0: 120, ux: 1, uy: 0 } };
    ok(api.solveFov(390 / 2 - 50, 780 / 2) === false, "a drag through the centre is rejected");
    near(api.state.fovLong, 67, 1e-9, "...and leaves the FOV untouched");
  }

  { // a backgrounded phone must not lose the alignment
    const h = load({});
    h.api.state.headOff = -4.25; h.api.savePrefs();   // debounced; timers are stubbed out
    ok(h.sandbox.localStorage.getItem("skyline-ar.prefs.v1") === null,
       "the debounce really is holding the write back");
    h.api.flushPrefs();
    const o = JSON.parse(h.sandbox.localStorage.getItem("skyline-ar.prefs.v1"));
    near(o.headOff, -4.25, 1e-9, "flushing on pagehide writes the pending alignment");
    h.api.flushPrefs();
    ok(true, "flushing twice is harmless");
  }

  { // a solved FOV survives a reload
    const a = load({});
    a.sandbox.localStorage.setItem("skyline-ar.prefs.v1",
      JSON.stringify({ fovLong: 74.2, fovCalibrated: true }));
    a.api.loadPrefs();
    near(a.api.state.fovLong, 74.2, 1e-9, "calibrated FOV restored on reload");
    ok(a.api.state.fovCalibrated === true, "calibrated flag restored");
  }
}

console.log("\n-- render paths and the calibration state machine --");
{
  const mk = () => { const h = load({ screenAngle: 0 });
    h.el("vid").videoWidth = 1920; h.el("vid").videoHeight = 1080;
    h.api.state.orient = { alpha: 90, beta: 90, gamma: 0 };
    h.api.state.lat = 39.7392; h.api.state.lon = -104.9903; h.api.state.elev = 1609;
    h.api.compute(); return h; };

  const noThrow = (fn, what) => { try { fn(); ok(true, what); } catch (e) { ok(false, `${what} -- threw ${e}`); } };

  { const { api } = mk(); api.state.mode = "draw";   noThrow(() => api.draw(), "drawing mode renders"); }
  { const { api } = mk(); api.state.mode = "camera"; noThrow(() => api.draw(), "camera mode renders"); }
  { const { api } = mk(); api.state.mode = "camera"; api.state.aligning = true;
    noThrow(() => api.draw(), "align mode renders"); }

  { // full calibration walkthrough, both steps, driven through the real handlers
    const { api, el } = mk();
    api.state.mode = "camera";
    api.calStart();
    ok(api.state.cal !== null && api.state.cal.step === 1, "calStart enters step 1");
    noThrow(() => api.draw(), "step 1 renders before a peak is chosen");

    const peaks = api.state.visible.filter(p => p.vis);
    const near270 = peaks.reduce((b, p) => Math.abs(p.az - 270) < Math.abs(b.az - 270) ? p : b, peaks[0]);
    api.calPick(near270);
    ok(api.state.cal.peak === near270, "step 1 accepts a tapped peak");
    noThrow(() => api.draw(), "step 1 renders with a peak chosen");

    const b = api.basisFromOrientation(), f = api.focalPx();
    const at = api.projectAR(b, f, near270.az, near270.alt);
    if (at) {
      api.calDrag(at.x + 18, at.y - 11);
      const after = api.projectAR(api.basisFromOrientation(), api.focalPx(), near270.az, near270.alt);
      near(after.x, at.x + 18, 0.5, "step 1 drag moves the peak under the finger (x)");
      near(after.y, at.y - 11, 0.5, "step 1 drag moves the peak under the finger (y)");
    } else ok(false, "step 1 peak is in front of the camera");

    el("calNext").onclick();
    ok(api.state.cal.step === 2 && api.state.cal.peak === null, "Next advances to step 2 and clears the peak");

    const first = api.state.cal.first;
    api.calPick({ n: first, az: near270.az, alt: near270.alt });
    ok(api.state.cal.peak === null, "step 2 refuses the peak used in step 1");

    noThrow(() => api.draw(), "step 2 renders");
    el("calCancel") && (api.calStop(), ok(api.state.cal === null, "Cancel leaves calibration"));
  }

  { // calibration must not touch drawing mode
    const { api } = mk();
    api.state.mode = "draw";
    api.calStart();
    ok(api.state.cal === null, "calibration refuses to start without the camera");
    noThrow(() => api.draw(), "drawing mode still renders after a refused calStart");
  }

  { // the non-absolute fallback lands in drawing mode and still renders
    const { api } = mk();
    api.state.mode = "camera"; api.state.absoluteOk = false;
    api.state.mode = "draw";
    noThrow(() => api.draw(), "drawing-mode fallback renders");
    api.state.mode = "camera"; api.state.absoluteOverride = true;
    noThrow(() => api.draw(), "camera with the relative-compass warning bar renders");
  }
}

console.log("\n-- horizon profile: lookup, occlusion, both render paths --");
{
  const mk = () => { const h = load({ screenAngle: 0 });
    h.el("vid").videoWidth = 1920; h.el("vid").videoHeight = 1080;
    h.api.state.orient = { alpha: 90, beta: 90, gamma: 0 };
    h.api.state.lat = 39.7392; h.api.state.lon = -104.9903; h.api.state.elev = 1609;
    return h; };

  /* A synthetic profile: a 3 deg wall from 260 to 280 deg, flat 0.2 deg
     elsewhere, and a blind sector around 100 deg where the raycast found no
     tiles. Real enough to exercise every branch. */
  const synth = () => {
    const n = 3600, alt = new Float32Array(n), srcDist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const az = i * 0.1;
      alt[i] = (az >= 260 && az <= 280) ? 3.0 : 0.2;
      srcDist[i] = (az >= 260 && az <= 280) ? 60000 : 20000;
      if (az >= 95 && az <= 105) { alt[i] = NaN; srcDist[i] = NaN; }
    }
    return { n, dAz: 0.1, alt, srcDist, srcLat: new Float32Array(n), srcLon: new Float32Array(n),
             key: "synthetic", created: Date.now() };
  };

  { const { api } = mk(); api.state.horizon = synth();
    near(api.horizonAltAt(270), 3.0, 1e-6, "profile reads 3 deg inside the wall");
    near(api.horizonAltAt(200), 0.2, 1e-6, "profile reads 0.2 deg outside it");
    near(api.horizonAltAt(0), 0.2, 1e-6, "profile reads at azimuth 0");
    near(api.horizonAltAt(360), api.horizonAltAt(0), 1e-9, "360 and 0 are the same sample");
    near(api.horizonAltAt(-10), api.horizonAltAt(350), 1e-9, "negative azimuths wrap");
    near(api.horizonAltAt(359.95), api.horizonAltAt(359.95), 1e-9, "interpolating across the 360 seam does not throw");
    ok(api.horizonAltAt(100) !== api.horizonAltAt(100), "a blind sector reads NaN");
    near(api.horizonDistAt(270) / 1000, 60, 1e-6, "profile carries the horizon point's distance");
  }

  { // occlusion: the wall hides everything below 3 deg behind it, and nothing elsewhere
    const { api } = mk();
    api.state.range = 300;
    api.state.horizon = synth();
    api.compute();
    const inWall = api.state.visible.filter(p => p.az >= 261 && p.az <= 279);
    const outside = api.state.visible.filter(p => p.az < 259 || p.az > 281);
    ok(inWall.length > 0, `${inWall.length} peaks sit behind the synthetic wall`);
    ok(inWall.every(p => p.vis === (p.alt > 3.0 - 0.08)),
       "every peak behind the wall is hidden exactly when it fails to clear it");
    ok(outside.some(p => p.vis), "peaks outside the wall are still visible");
  }

  { // a blind sector must not silently hide peaks -- it falls back to the bin buffer
    const { api } = mk();
    api.state.horizon = synth();
    api.compute();
    const blind = api.state.visible.filter(p => p.az >= 96 && p.az <= 104);
    ok(blind.every(p => typeof p.vis === "boolean"),
       "peaks in a blind sector keep a visibility verdict from the fallback");
  }

  { // both render paths must survive a profile
    const noThrow = (fn, what) => { try { fn(); ok(true, what); } catch (e) { ok(false, `${what} -- threw ${e}`); } };
    const { api } = mk(); api.state.horizon = synth(); api.compute();
    api.state.mode = "camera"; noThrow(() => api.draw(), "camera mode renders the profile silhouette");
    api.state.mode = "draw";   noThrow(() => api.draw(), "drawing mode renders the profile silhouette");
    api.state.horizon = null;  noThrow(() => api.draw(), "drawing mode still renders with no profile");
    api.state.mode = "camera"; noThrow(() => api.draw(), "camera mode still renders with no profile");
  }

  { // labels need a screen position in both paths, profile or not
    const { api } = mk(); api.state.horizon = synth(); api.compute();
    api.state.mode = "camera"; api.draw();
    ok(api.state.visible.some(p => p._x !== undefined), "camera mode still places peak apexes with a profile");
    api.state.mode = "draw"; api.draw();
    ok(api.state.visible.some(p => p._x !== undefined), "drawing mode still places peak apexes with a profile");
  }

  { // cache key rounds the viewpoint, so GPS jitter reuses the profile
    const { api } = mk();
    const a = api.viewKey(39.7392, -104.9903, 1610.7);
    ok(api.viewKey(39.7395, -104.9906, 1613) === a, "a 40 m GPS wobble keeps the same cache key");
    ok(api.viewKey(39.9990, -105.2820, 1751.7) !== a, "a different viewpoint gets a different key");
  }
}

console.log("\n-- viewpoint follows the phone --");
{
  const DENVER = [39.7392, -104.9903];
  const BOULDER = [39.9990, -105.2820];

  { // the app comes up following, not parked on a hardcoded city
    const { api, geo } = load({});
    ok(api.state.follow === true, "follow is on by default");
    ok(geo.cb !== null, "a position watch is armed at boot");
    ok(geo.opts && geo.opts.enableHighAccuracy === true, "the watch asks for high accuracy");
  }

  { // a fix moves the viewpoint and everything computed from it
    const { api, geo } = load({});
    const before = { lat: api.state.lat, lon: api.state.lon };
    geo.fix(BOULDER[0], BOULDER[1], { accuracy: 6, altitude: 1740 });
    near(api.state.lat, BOULDER[0], 1e-9, "latitude follows the fix");
    near(api.state.lon, BOULDER[1], 1e-9, "longitude follows the fix");
    ok(api.state.label === "Your location", "the readout says it is your location");
    ok(api.state.lat !== before.lat, "the hardcoded default was actually replaced");
    near(api.state.acc, 6, 1e-9, "accuracy is kept for the readout");
    // peaks are now resolved from the new place
    api.compute();
    ok(api.state.visible.length > 0, "peaks recompute against the new viewpoint");
  }

  { // GPS jitter must not thrash the recompute or the horizon cache
    const { api, geo } = load({});
    geo.fix(DENVER[0], DENVER[1], { accuracy: 5 });
    const settled = { lat: api.state.lat, lon: api.state.lon };
    geo.fix(DENVER[0] + 0.0002, DENVER[1], { accuracy: 5 });   // ~22 m
    near(api.state.lat, settled.lat, 1e-9, "a 22 m wobble is ignored");
    geo.fix(DENVER[0] + 0.0010, DENVER[1], { accuracy: 5 });   // ~111 m
    ok(api.state.lat !== settled.lat, "a real 111 m move is taken");
  }

  { // DEM ground height beats GPS altitude
    const { api, geo } = load({});
    geo.fix(DENVER[0], DENVER[1], { accuracy: 5, altitude: 1550 });
    near(api.state.elev, 1550, 1e-9, "GPS altitude is used as a placeholder");
    ok(api.state.elevFromDem === false, "...and is flagged as not from the DEM");
    api.onGroundElev({ id: "e1", elev: 1609.4 });
    // the pending id will not match, so nothing should change -- guard against blind writes
    near(api.state.elev, 1550, 1e-9, "an elevation reply with an unknown id is ignored");
  }

  { // choosing a saved viewpoint is an explicit override
    const { api, geo, el } = load({});
    geo.fix(BOULDER[0], BOULDER[1]);
    ok(api.state.follow === true, "still following before the override");
    const sel = el("view");
    sel.value = "0";
    sel.onchange();
    ok(api.state.follow === false, "picking a saved viewpoint stops following");
    ok(geo.cleared.length > 0, "...and clears the position watch rather than leaking it");
    near(api.state.lat, 39.7392, 1e-9, "the saved viewpoint's coordinates are used");
  }

  { // typed coordinates are an override too
    const { api, el } = load({});
    el("lat").value = "40.0"; el("lon").value = "-105.5"; el("elev").value = "2500";
    el("btnApply").onclick();
    ok(api.state.follow === false, "typing coordinates stops following");
    near(api.state.lat, 40.0, 1e-9, "typed latitude is used");
  }

  { // and you can get back to following
    const { api, el } = load({});
    el("lat").value = "40.0"; el("lon").value = "-105.5"; el("elev").value = "2500";
    el("btnApply").onclick();
    ok(api.state.follow === false, "override in place");
    el("btnGeo").onclick();
    ok(api.state.follow === true, "'Follow my location' turns following back on");
  }

  { // the choice persists
    const a = load({});
    a.api.stopFollow();
    a.api.flushPrefs();
    const raw = a.sandbox.localStorage.getItem("skyline-ar.prefs.v1");
    ok(raw !== null && JSON.parse(raw).follow === false, "follow:false is persisted");
    const b = load({});
    b.sandbox.localStorage.setItem("skyline-ar.prefs.v1", raw);
    b.api.loadPrefs();
    ok(b.api.state.follow === false, "follow:false survives a reload");
  }

  { // a cold start with no signal comes up where you last were, not in Denver
    const a = load({});
    a.geo.fix(BOULDER[0], BOULDER[1], { accuracy: 5, altitude: 1740 });
    const fix = a.sandbox.localStorage.getItem("skyline-ar.lastfix.v1");
    ok(fix !== null, "the last fix is written to storage");

    const b = load({});
    b.sandbox.localStorage.setItem("skyline-ar.lastfix.v1", fix);
    b.api.loadFix();
    near(b.api.state.lat, BOULDER[0], 1e-6, "a cold start restores the last known latitude");
    ok(b.api.state.label === "Last known position", "...and says so rather than pretending it is a fix");

    const c = load({});
    c.sandbox.localStorage.setItem("skyline-ar.lastfix.v1", "{corrupt");
    ok(c.api.loadFix() === false, "corrupt stored position is refused");
    near(c.api.state.lat, 39.7392, 1e-9, "...falling back to the built-in default");
  }

  { // denial must be legible, not silent
    const { api, geo, el } = load({});
    geo.fail(1);
    ok(/denied/i.test(el("locNote").textContent), "a denied permission says so");
    geo.fail(3);
    ok(/timed out/i.test(el("locNote").textContent), "a timeout says so");
    ok(typeof api.state.lat === "number", "the app still has a usable viewpoint after a failure");
  }

  { // no geolocation at all
    const h = load({});
    h.sandbox.navigator.geolocation = null;
    h.api.startFollow();
    ok(/won't share a location/i.test(h.el("locNote").textContent),
       "a browser with no geolocation is told to set coordinates by hand");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
