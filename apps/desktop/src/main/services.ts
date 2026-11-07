import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isHostDb, listBackups, prune, restoreInto, snapshot, type BackupInfo } from "../../../../packages/server/src/backup";
import * as localHost from "./localHost";
import { s } from "./strings";
import { markQuitting } from "./tray";

/*
 * Background services of the desktop app (CLAUDE.md §12.3):
 *  - host database backups: list / now / export / import / restore (daily ones are made by the host)
 *  - auto-update with electron-updater (installed app only; the feed comes from electron-builder, Faz 5)
 *  - log folder (%APPDATA%/NooXCord/logs): main-process errors, rotated at 1 MB
 */

// ---------- logs ----------
const logDir = () => path.join(app.getPath("userData"), "logs");

export function initLogs(): void {
  const file = path.join(logDir(), "main.log");
  const write = (level: string, a: unknown[]) => {
    try {
      fs.mkdirSync(logDir(), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + ".1");
      const text = a.map((x) => (x instanceof Error ? x.stack ?? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ");
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch { /* never fail because of logging */ }
  };
  process.on("uncaughtException", (e) => write("ERROR", [e]));
  process.on("unhandledRejection", (e) => write("ERROR", [e]));
  const origErr = console.error.bind(console);
  console.error = (...a: unknown[]) => { write("ERROR", a); origErr(...a); };
}

// ---------- backups ----------
const backupsDir = () => path.join(localHost.hostDataDir(), "backups");
const dbFile = () => path.join(localHost.hostDataDir(), "nooxcord.db");

async function backupNow(tag?: string): Promise<BackupInfo> {
  const viaHost = await localHost.requestBackup(tag);
  if (viaHost) return viaHost;
  if (!fs.existsSync(dbFile())) throw new Error(s("backup.none"));
  const b = snapshot(dbFile(), backupsDir(), tag);
  prune(backupsDir());
  return b;
}

/** Stops the host, keeps a copy of the current data, swaps the database, starts the host again. */
async function restoreFrom(file: string): Promise<void> {
  if (!isHostDb(file)) throw new Error(s("backup.invalid"));
  const st = localHost.status();
  const port = st.running ? st.port : null;
  if (fs.existsSync(dbFile())) await backupNow("prerestore");
  // Copy first: restoring one of our own backups must survive the pruning above.
  const tmp = path.join(app.getPath("temp"), `nooxcord-restore-${Date.now()}.db`);
  fs.copyFileSync(file, tmp);
  try {
    if (port) await localHost.stop();
    restoreInto(dbFile(), tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
    if (port) await localHost.start(port);
  }
}

function registerBackupIpc(win: () => BrowserWindow | null): void {
  ipcMain.handle("backup:list", () => listBackups(backupsDir()));
  ipcMain.handle("backup:now", () => backupNow());
  ipcMain.handle("backup:openFolder", () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    return shell.openPath(backupsDir());
  });
  ipcMain.handle("backup:restore", (_e, name: unknown) => {
    const b = listBackups(backupsDir()).find((x) => x.name === name);
    if (!b) throw new Error(s("backup.invalid"));
    return restoreFrom(path.join(backupsDir(), b.name));
  });
  ipcMain.handle("backup:export", async () => {
    const w = win();
    const opts = { title: s("main.backup.dialogExport"), defaultPath: `nooxcord-backup-${new Date().toISOString().slice(0, 10)}.db`, filters: [{ name: s("main.backup.filter"), extensions: ["db"] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return false;
    const b = await backupNow();
    fs.copyFileSync(path.join(backupsDir(), b.name), r.filePath);
    return true;
  });
  ipcMain.handle("backup:import", async () => {
    const w = win();
    const opts = { title: s("main.backup.dialogImport"), properties: ["openFile" as const], filters: [{ name: s("main.backup.filter"), extensions: ["db", "sqlite"] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    const file = r.filePaths[0];
    if (r.canceled || !file) return false;
    await restoreFrom(file);
    return true;
  });
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
  const { autoUpdater } = await import("electron-updater");
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
  const u = await getUpdater();
  if (!u) return (update = { status: "dev", current: app.getVersion() });
  try {
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

export function registerServices(win: () => BrowserWindow | null): void {
  registerBackupIpc(win);
  registerUpdateIpc();
  ipcMain.handle("app:openLogs", () => {
    fs.mkdirSync(logDir(), { recursive: true });
    return shell.openPath(logDir());
  });
}
