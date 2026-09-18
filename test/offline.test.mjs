/* The offline story fails silently: a typo in the precache list just means the
   app does not open on a ridge, with nothing to see at the desk. So check that
   every path the service worker and the manifest promise actually exists, and
   that the HTML references them consistently.
   Run: node test/offline.test.mjs */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = f => readFileSync(join(root, f), "utf8");

let pass = 0, fail = 0;
const ok = (c, what) => { c ? pass++ : fail++; console.log(`${c ? "ok  " : "FAIL"}  ${what}`); };

const sw = read("sw.js");
const html = read("index.html");
const manifest = JSON.parse(read("manifest.webmanifest"));

console.log("\n-- precache list --");
{
  const list = JSON.parse(sw.match(/const SHELL_FILES = \(?(\[[\s\S]*?\])/)[1].replace(/,(\s*\])/, "$1"));
  ok(list.length >= 4, `service worker precaches ${list.length} files`);
  for (const f of list) {
    if (f === "./") { ok(existsSync(join(root, "index.html")), "'./' resolves to index.html"); continue; }
    ok(existsSync(join(root, f)), `precached ${f} exists`);
  }
  for (const needed of ["./index.html", "./horizon-worker.js", "./manifest.webmanifest"])
    ok(list.includes(needed), `${needed} is precached — the app is useless offline without it`);
  ok(list.every(f => f.startsWith("./")),
     "every precache path is relative, so it works under a GitHub Pages project path");
}

console.log("\n-- manifest --");
{
  for (const k of ["name", "short_name", "start_url", "scope", "display", "icons"])
    ok(manifest[k] !== undefined, `manifest declares ${k}`);
  ok(manifest.display === "standalone", "manifest asks for standalone display");
  ok(manifest.start_url.startsWith("./") && manifest.scope.startsWith("./"),
     "manifest start_url and scope are relative");
  for (const i of manifest.icons) ok(existsSync(join(root, i.src)), `manifest icon ${i.src} exists`);
  ok(manifest.icons.some(i => i.sizes === "192x192"), "manifest has a 192px icon");
  ok(manifest.icons.some(i => i.sizes === "512x512"), "manifest has a 512px icon");
  ok(manifest.icons.some(i => (i.purpose || "").includes("maskable")), "manifest has a maskable icon");
}

console.log("\n-- html wiring --");
{
  ok(/<link rel="manifest" href="manifest\.webmanifest">/.test(html), "html links the manifest");
  ok(/rel="apple-touch-icon" href="icons\/apple-touch-icon\.png"/.test(html), "html links an apple-touch-icon");
  ok(existsSync(join(root, "icons/apple-touch-icon.png")), "the apple-touch-icon exists");
  ok(/name="theme-color"/.test(html), "html sets a theme colour");
  ok(/serviceWorker\.register\("sw\.js"/.test(html), "html registers sw.js by a relative path");
  ok(/new Worker\("horizon-worker\.js"\)/.test(html), "html loads the raycaster by a relative path");
  ok(!/https?:\/\/(?!s3\.amazonaws\.com|overpass-api\.de|www\.peakfinder\.com)[^"' ]*\.(js|css)/.test(html),
     "html pulls in no external script or stylesheet");
  ok(!/<script[^>]+src=/.test(html), "html has no external <script src> at all");
}

console.log("\n-- caching strategy --");
{
  ok(/elevation-tiles-prod/.test(sw), "terrain tiles are recognised by the service worker");
  ok(/req\.mode === "navigate"/.test(sw), "navigations are handled separately from assets");
  ok(/skyline-tiles-v1/.test(sw) && /skyline-shell-/.test(sw),
     "tiles and shell live in separate caches, so an app update does not evict 160 terrain tiles");
  ok(/caches\.delete\(k\)/.test(sw), "stale shell caches are cleaned up on activate");
  ok(/TILE_MAX/.test(sw), "the tile cache is bounded");
  ok(/req\.method !== "GET"/.test(sw), "non-GET requests are left alone");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
