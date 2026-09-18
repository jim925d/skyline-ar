/* Loads the real <script> out of index.html and runs it against a minimal DOM
   stub, so the tests exercise the shipped functions rather than a copy of the
   maths. Node only; the app itself still has no dependencies and no build step. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

function stubCtx() {
  const noop = () => {};
  return new Proxy({ measureText: () => ({ width: 40 }),
                     createLinearGradient: () => ({ addColorStop: noop }),
                     createRadialGradient: () => ({ addColorStop: noop }),
                     setTransform: noop, save: noop, restore: noop },
    { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
}

function stubEl(id) {
  const el = {
    id, value: "", textContent: "", innerHTML: "", checked: false,
    style: new Proxy({}, { get: () => "", set: () => true }),
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                 toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c);}, contains(c){return this._s.has(c);} },
    dataset: {}, children: [],
    getContext: () => stubCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 780 }),
    setAttribute(){}, getAttribute(){ return null; },
    appendChild(c){ this.children.push(c); return c; },
    addEventListener(){}, removeEventListener(){},
    setPointerCapture(){}, focus(){},
  };
  el.parentElement = el;
  return el;
}

export function load({ width = 390, height = 780, screenAngle = 0 } = {}) {
  const html = readFileSync(join(here, "..", "index.html"), "utf8");
  const src = html.match(/<script>\n([\s\S]*?)\n<\/script>/)[1];

  const els = new Map();
  const getEl = id => { if (!els.has(id)) els.set(id, stubEl(id)); return els.get(id); };

  const store = new Map();
  /* Drivable geolocation: tests push fixes through geo.fix(...) rather than
     waiting on a real device. */
  const geo = {
    nextId: 0, cb: null, errCb: null, cleared: [], opts: null,
    watchPosition(cb, err, opts) { this.cb = cb; this.errCb = err; this.opts = opts; return ++this.nextId; },
    clearWatch(id) { this.cleared.push(id); },
    getCurrentPosition(cb, err) { this.cb = cb; this.errCb = err; },
    fix(latitude, longitude, { accuracy = 8, altitude = null } = {}) {
      this.cb && this.cb({ coords: { latitude, longitude, accuracy, altitude } });
    },
    fail(code) { this.errCb && this.errCb({ code }); },
  };
  const sandbox = {
    console, Math, Date, JSON, Number, String, Array, Object, Float32Array, Set, Map,
    isNaN, parseFloat, parseInt, alert: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null),
                    setItem: (k, v) => store.set(k, String(v)),
                    removeItem: k => store.delete(k) },
    screen: { orientation: { angle: screenAngle, addEventListener(){} } },
    indexedDB: { open: () => { const r = { onupgradeneeded: null, onsuccess: null, onerror: null };
                               return r; } },        // never fires: cache lookups stay pending, which is fine
    Worker: undefined,
    Float64Array, Int16Array, Int8Array, Promise, Function, Error, performance: { now: () => 0 },
    navigator: { geolocation: geo, mediaDevices: null },
    document: { getElementById: getEl, createElement: () => stubEl("new"),
                addEventListener(){}, body: stubEl("body") },
    _store: store,
  };
  sandbox.window = sandbox;
  sandbox.window.isSecureContext = true;
  sandbox.window.addEventListener = () => {};
  sandbox.window.devicePixelRatio = 2;
  sandbox.window.orientation = screenAngle;
  sandbox.DeviceOrientationEvent = undefined;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__api={state,basisFromOrientation,projectAR,focalPx,fovFromFocal,worldVec,dot,compute,draw,resize,dist,bearing,apparentAlt,loadPrefs,savePrefs,flushPrefs,syncPrefControls,solveAxis,solveFov,calStart,calPick,calStop,calDrag,drawAR,drawPanorama,horizonAltAt,horizonDistAt,viewKey,currentKey,startFollow,stopFollow,loadFix,saveFix,onGroundElev,syncInputs};", ctx,
                  { filename: "index.html#script" });

  const api = vm.runInContext("__api", ctx);
  // the canvas stub reports 390x780; resize() picks it up
  api.state.screenAngle = screenAngle;
  return { api, sandbox, el: getEl, geo, W: width, H: height };
}
