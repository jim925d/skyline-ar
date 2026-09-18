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
    // stores what the app writes, so tests can assert on visibility
    style: new Proxy({}, { get: (t, k) => (k in t ? t[k] : ""), set: (t, k, v) => { t[k] = v; return true; } }),
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                 toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c);}, contains(c){return this._s.has(c);} },
    dataset: {}, children: [],
    getContext: () => stubCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 780 }),
    setAttribute(){}, getAttribute(){ return null; },
    appendChild(c){ this.children.push(c); return c; },
    addEventListener(){}, removeEventListener(){},
    setPointerCapture(){}, focus(){},
    srcObject: null, videoWidth: 0, videoHeight: 0, play: async () => {},
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
  const timers = [];
  const listeners = Object.create(null);
  /* Records the order of the two permission prompts, which is the whole point
     of one of the tests below. */
  const calls = [];
  const orient = { permission: "granted", throwOn: null };
  const media = { fail: null };
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
    /* Timers are recorded, not run: tests fire the watchdogs deliberately via
       runTimers() so a 3.5s wait never becomes a 3.5s test. */
    setTimeout: (fn, ms) => { timers.push({ fn, ms: ms || 0, cancelled: false }); return timers.length; },
    clearTimeout: id => { const t = timers[id - 1]; if (t) t.cancelled = true; },
    requestAnimationFrame: () => 0,
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
  sandbox.navigator.mediaDevices = {
    getUserMedia: async () => { calls.push("getUserMedia");
      if (media.fail) throw Object.assign(new Error("denied"), { name: media.fail });
      return { getTracks: () => [] }; },
  };
  sandbox.window.isSecureContext = true;
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.window.devicePixelRatio = 2;
  sandbox.window.orientation = screenAngle;
  Object.defineProperty(sandbox, "DeviceOrientationEvent", {
    configurable: true,
    get() { return orient.permission === null ? undefined : {
      requestPermission: async () => { calls.push("requestPermission");
        if (orient.throwOn) throw Object.assign(new Error(orient.throwOn.msg), { name: orient.throwOn.name });
        return orient.permission; } }; },
  });

  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__api={state,basisFromOrientation,projectAR,focalPx,fovFromFocal,worldVec,dot,compute,draw,resize,dist,bearing,apparentAlt,loadPrefs,savePrefs,flushPrefs,syncPrefControls,solveAxis,solveFov,calStart,calPick,calStop,calDrag,drawAR,drawPanorama,horizonAltAt,horizonDistAt,viewKey,currentKey,askMotion,retryCompass,failNoCompass,startFollow,stopFollow,loadFix,saveFix,onGroundElev,syncInputs};", ctx,
                  { filename: "index.html#script" });

  const api = vm.runInContext("__api", ctx);
  // the canvas stub reports 390x780; resize() picks it up
  api.state.screenAngle = screenAngle;
  return {
    api, sandbox, el: getEl, geo, calls, orient, media, W: width, H: height,
    fire: (type, ev) => (listeners[type] || []).forEach(fn => fn(ev)),
    hasListener: type => (listeners[type] || []).length > 0,
    runTimers: () => { const due = timers.filter(t => !t.cancelled && !t.done);
                       due.forEach(t => { t.done = true; t.fn(); }); return due.length; },
  };
}
