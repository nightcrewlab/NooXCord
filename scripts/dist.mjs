// Builds NooXCord-Setup-<version>.exe (CLAUDE.md §14).
//  1. client (vite) + desktop bundles (esbuild) — run by `pnpm dist` before this script
//  2. stages release/app: bundles + only the runtime modules the bundles leave external
//  3. electron-builder → release/NooXCord-Setup-<version>.exe
// Usage: node scripts/dist.mjs [--dir]   (--dir: unpacked app only, no installer)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const stage = path.join(root, "release/app");
const res = path.join(root, "release/resources");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));

const fail = (m) => { console.error("dist:", m); process.exit(1); };
const need = (p, hint) => { if (!fs.existsSync(p)) fail(`${path.relative(root, p)} missing — ${hint}`); return p; };

need(path.join(desktop, "out/main.cjs"), "run pnpm build");
need(path.join(root, "packages/client/dist/index.html"), "run pnpm build");
const nativeNode = need(path.join(root, "packages/native/nooxcord-native.win32-x64.node"), "run pnpm build:native");
const cloudflared = need(path.join(root, ".tools/cloudflared.exe"), "download cloudflared.exe into .tools/");

fs.rmSync(path.join(root, "release"), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// ---------- app folder ----------
fs.cpSync(path.join(desktop, "out"), path.join(stage, "out"), { recursive: true, filter: (f) => !f.endsWith(".map") });
// tray / window icons: main.cjs loads them from ../resources relative to out/ (inside app.asar)
fs.cpSync(path.join(desktop, "resources"), path.join(stage, "resources"), { recursive: true });

// Runtime modules: copy each package and its dependency closure (hoisted layout, nested node_modules respected).
const nm = path.join(stage, "node_modules");
const copied = new Set();
function copyPkg(name, fromDir, only) {
  const req = createRequire(path.join(fromDir, "noop.js"));
  let pj;
  try { pj = req.resolve(`${name}/package.json`); } catch {
    // packages with "exports" that hide package.json: walk up from the main entry
    let d = path.dirname(req.resolve(name));
    while (!fs.existsSync(path.join(d, "package.json")) || JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name !== name) d = path.dirname(d);
    pj = path.join(d, "package.json");
  }
  const dir = path.dirname(pj);
  if (copied.has(dir)) return;
  copied.add(dir);
  const dest = path.join(nm, name);
  if (fs.existsSync(dest)) return; // same name already staged from another version: first one wins (hoisted)
  if (only) for (const f of only) fs.cpSync(path.join(dir, f), path.join(dest, f), { recursive: true });
  else fs.cpSync(dir, dest, { recursive: true, dereference: true, filter: (f) => {
    const rel = path.relative(dir, f);
    return !/^(test|tests|docs|\.github)([\\/]|$)/.test(rel) && !/\.(map|md|ts)$/.test(f);
  } });
  const deps = JSON.parse(fs.readFileSync(pj, "utf8")).dependencies ?? {};
  for (const d of Object.keys(deps)) copyPkg(d, dir);
}
copyPkg("electron-updater", desktop);
copyPkg("mediasoup", path.join(root, "packages/server"), ["package.json", "LICENSE", "node/lib", "worker/out/Release/mediasoup-worker.exe"]);
// workspace native module: loader + prebuilt .node only
fs.mkdirSync(path.join(nm, "@nooxcord/native"), { recursive: true });
for (const f of ["package.json", "index.js"]) fs.copyFileSync(path.join(root, "packages/native", f), path.join(nm, "@nooxcord/native", f));
fs.copyFileSync(nativeNode, path.join(nm, "@nooxcord/native", path.basename(nativeNode)));

// electron-builder collects node_modules from the declared dependencies (npm ls in the staged folder)
const ver = (n) => JSON.parse(fs.readFileSync(path.join(nm, n, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
  name: "nooxcord", productName: "NooXCord", version: pkg.version, description: pkg.description, author: pkg.author,
  license: "UNLICENSED", main: "out/main.cjs",
  dependencies: Object.fromEntries(["electron-updater", "mediasoup", "@nooxcord/native"].map((n) => [n, ver(n)])),
}, null, 2));

// ---------- extra resources ----------
fs.cpSync(path.join(root, "packages/client/dist"), path.join(res, "web"), { recursive: true });
fs.mkdirSync(path.join(res, "bin"), { recursive: true });
fs.copyFileSync(cloudflared, path.join(res, "bin/cloudflared.exe"));
fs.cpSync(path.join(root, "apps/desktop/build/licenses"), path.join(res, "licenses"), { recursive: true });

// Visual C++ runtime (mediasoup-worker.exe and the native module need it). Deployed app-local, so the
// per-user installer needs no admin rights: next to NooXCord.exe and next to mediasoup-worker.exe.
const vc = findVcRuntime();
if (!vc) fail("Visual C++ x64 runtime DLLs not found (install Visual Studio Build Tools, or put them in .tools/vcruntime/)");
const vcFiles = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];
fs.mkdirSync(path.join(root, "release/vcruntime"), { recursive: true });
for (const f of vcFiles) {
  fs.copyFileSync(path.join(vc, f), path.join(root, "release/vcruntime", f));
  fs.copyFileSync(path.join(vc, f), path.join(nm, "mediasoup/worker/out/Release", f));
}
console.log("staged app:", path.relative(root, stage), "· vc runtime:", vc);

// ---------- electron-builder ----------
const bin = path.join(root, "node_modules/.bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
const args = ["--projectDir", desktop, "--config", path.join(desktop, "electron-builder.yml"), "--win", "--x64", "--publish", "never"];
if (process.argv.includes("--dir")) args.push("--dir");
execFileSync(bin, args, { cwd: desktop, stdio: "inherit", shell: process.platform === "win32" }); // .cmd needs a shell; args are fixed paths

function findVcRuntime() {
  const local = path.join(root, ".tools/vcruntime");
  if (vcOk(local)) return local;
  const bases = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean).map((p) => path.join(p, "Microsoft Visual Studio"));
  const found = [];
  for (const b of bases) {
    for (const year of safeLs(b)) for (const ed of safeLs(path.join(b, year))) {
      const redist = path.join(b, year, ed, "VC/Redist/MSVC");
      for (const ver of safeLs(redist)) for (const crt of safeLs(path.join(redist, ver, "x64")).filter((x) => /^Microsoft\.VC\d+\.CRT$/.test(x))) {
        const d = path.join(redist, ver, "x64", crt);
        if (vcOk(d)) found.push({ d, ver });
      }
    }
  }
  // newest runtime wins (it is backward compatible with older toolsets)
  found.sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
  return found[0]?.d ?? null;
}
function vcOk(d) { return ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"].every((f) => fs.existsSync(path.join(d, f))); }
function safeLs(d) { try { return fs.readdirSync(d); } catch { return []; } }
