import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { markQuitting } from "./tray";

/*
 * Background services of the desktop app (CLAUDE.md §12.3):
 *  - auto-update with electron-updater (installed app only; the feed comes from electron-builder, Faz 5)
 *  - log folder (%APPDATA%/NooXCord/logs): main-process errors, rotated at 1 MB
 */

// ---------- logs ----------
const logDir = () => path.join(app.getPath("userData"), "logs");

function write(level: string, a: unknown[]): void {
  const file = path.join(logDir(), "main.log");
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + ".1");
    const text = a.map((x) => (x instanceof Error ? x.stack ?? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch { /* never fail because of logging */ }
}

/** Diagnostic line in main.log (stream health, memory use). */
export function logInfo(text: string): void {
  write("INFO", [text]);
}

export function initLogs(): void {
  process.on("uncaughtException", (e) => write("ERROR", [e]));
  process.on("unhandledRejection", (e) => write("ERROR", [e]));
  const origErr = console.error.bind(console);
  console.error = (...a: unknown[]) => { write("ERROR", a); origErr(...a); };
}

// ---------- updates ----------
interface UpdateState { status: "idle" | "dev" | "checking" | "none" | "downloading" | "ready" | "error"; current: string; version?: string; pct?: number; error?: string }

let update: UpdateState = { status: "idle", current: app.getVersion() };
type Updater = typeof import("electron-updater").autoUpdater;
let updater: Updater | null = null;

const broadcast = (st: UpdateState) => {
  update = st;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("updates:state", st);
};

/** Installed builds carry app-update.yml (written by electron-builder); dev builds do not update. */
const canUpdate = () => app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));

async function getUpdater(): Promise<Updater | null> {
  if (!canUpdate()) return null;
  if (updater) return updater;
  // electron-updater is CommonJS with a getter export: Node's ESM import() only sees it on .default.
  const mod = (await import("electron-updater")) as unknown as { autoUpdater?: Updater; default?: { autoUpdater?: Updater } };
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!autoUpdater) throw new Error("electron-updater: autoUpdater missing");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => broadcast({ status: "checking", current: app.getVersion() }));
  autoUpdater.on("update-not-available", () => broadcast({ status: "none", current: app.getVersion() }));
  autoUpdater.on("update-available", (i) => broadcast({ status: "downloading", current: app.getVersion(), version: i.version, pct: 0 }));
  autoUpdater.on("download-progress", (p) => broadcast({ ...update, status: "downloading", pct: p.percent }));
  autoUpdater.on("update-downloaded", (i) => broadcast({ status: "ready", current: app.getVersion(), version: i.version }));
  autoUpdater.on("error", (e) => broadcast({ status: "error", current: app.getVersion(), error: e.message }));
  updater = autoUpdater;
  return updater;
}

async function check(): Promise<UpdateState> {
  try {
    const u = await getUpdater(); // a failure here must reach the UI too, not only the log
    if (!u) return (update = { status: "dev", current: app.getVersion() });
    await u.checkForUpdates();
  } catch (e) {
    broadcast({ status: "error", current: app.getVersion(), error: (e as Error).message });
  }
  return update;
}

function registerUpdateIpc(): void {
  if (!canUpdate()) update = { status: "dev", current: app.getVersion() };
  ipcMain.handle("updates:get", () => update);
  ipcMain.handle("updates:check", () => check());
  ipcMain.handle("updates:install", () => {
    if (update.status !== "ready" || !updater) return;
    markQuitting();
    updater.quitAndInstall();
  });
  // Quietly check shortly after start and then every 6 hours.
  if (canUpdate() && !process.env.NX_SELFTEST) {
    setTimeout(() => void check(), 15_000);
    setInterval(() => void check(), 6 * 60 * 60_000).unref();
  }
}

export function registerServices(): void {
  registerUpdateIpc();
  ipcMain.handle("app:openLogs", () => {
    fs.mkdirSync(logDir(), { recursive: true });
    return shell.openPath(logDir());
  });
  if (!process.env.NX_SELFTEST) startMemoryWatch();
}

// ---------- memory ----------
/*
 * Memory per Chromium process (renderer, GPU, host utility process...), sampled every 5 min:
 * a short line every 30 min, the full breakdown whenever the total passes another 512 MB.
 * mediasoup-worker.exe (a child of the host process) is not in getAppMetrics.
 */
function startMemoryWatch(): void {
  let lastLine = 0;
  let level = 1; // 512 MB steps already reported
  const sample = () => {
    const ms = app.getAppMetrics();
    const mb = (kb: number | undefined) => Math.round((kb ?? 0) / 1024);
    const rows = ms.map((m) => ({ what: m.serviceName ?? m.name ?? m.type, type: m.type, priv: mb(m.memory.privateBytes), ws: mb(m.memory.workingSetSize) }));
    const total = rows.reduce((a, r) => a + r.priv, 0);
    const now = Date.now();
    const step = Math.floor(total / 512);
    if (step > level) {
      level = step;
      rows.sort((a, b) => b.priv - a.priv);
      logInfo(`[memory] total ${total} MB private: ${rows.map((r) => `${r.type}${r.what !== r.type ? `(${r.what})` : ""} ${r.priv}/${r.ws}`).join(", ")}`);
      lastLine = now;
    } else if (now - lastLine >= 30 * 60_000) {
      const byType = new Map<string, number>();
      for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + r.priv);
      logInfo(`[memory] total ${total} MB private (${[...byType].map(([k, v]) => `${k} ${v}`).join(", ")})`);
      lastLine = now;
    }
    if (step < level - 1) level = Math.max(1, step); // dropped back: report the next climb again
  };
  setTimeout(sample, 60_000).unref();
  setInterval(sample, 5 * 60_000).unref();
}
