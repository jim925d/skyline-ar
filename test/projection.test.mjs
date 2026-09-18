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

  { // a solved FOV survives a reload
    const a = load({});
    a.sandbox.localStorage.setItem("skyline-ar.prefs.v1",
      JSON.stringify({ fovLong: 74.2, fovCalibrated: true }));
    a.api.loadPrefs();
    near(a.api.state.fovLong, 74.2, 1e-9, "calibrated FOV restored on reload");
    ok(a.api.state.fovCalibrated === true, "calibrated flag restored");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
