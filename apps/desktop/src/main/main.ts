import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hosts } from "./hosts";
import * as localHost from "./localHost";
import { destroyOverlay, registerOverlay } from "./overlay";
import { registerMediaIpc, shutdownMedia } from "./media";
import { endRemote, registerRemoteIpc } from "./remote";
import { initLogs, registerServices } from "./services";
import { createTray, destroyTray, isQuitting, markQuitting, registerTray, showMain, startHidden } from "./tray";
import { hostStopped, registerNetIpc, registerNetShortcuts, shutdownNet } from "./netIpc";
import { prepareVoiceTest, voiceSelfTest } from "./voiceTest";

// User data lives in %APPDATA%/NooXCord; self-tests use a throwaway folder.
app.setName("NooXCord");
if (process.env.NX_SELFTEST) app.setPath("userData", path.join(os.tmpdir(), "nooxcord-selftest"));

if (process.env.NX_SELFTEST === "voice") prepareVoiceTest();
if (!app.requestSingleInstanceLock()) app.quit();
// Dev runs (electron.exe) get their own ID: Windows caches the taskbar icon per ID, and an Electron-icon
// entry under the real ID made the installed app show the Electron logo.
const AUMID = app.isPackaged ? "com.nooxrii.nooxcord" : "com.nooxrii.nooxcord.dev";
app.setAppUserModelId(AUMID);
// Hidden / minimised (a game in front) the renderer dropped to background CPU priority, and the voice
// it decodes and the microphone it processes broke up (robotic / crackling). Keep it at normal priority.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
initLogs();

let mainWindow: BrowserWindow | null = null;

/*
 * nooxcord://join?url=<host origin>[&invite=<code>] (CLAUDE.md §10.6): opens a host, a tunnel URL
 * included, straight in the app. The installer registers the scheme; Windows passes the link in argv.
 */
interface JoinLink { url: string; invite: string | null }
function parseJoin(argv: readonly string[]): JoinLink | null {
  const raw = argv.find((a) => /^nooxcord:\/\//i.test(a));
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const q = u.searchParams;
    let host = q.get("url");
    if (!host && q.get("h")) host = `http://${q.get("h")}:${q.get("p") ?? "47820"}`;
    if (!host) return null;
    const h = new URL(host);
    if (h.protocol !== "http:" && h.protocol !== "https:") return null;
    const invite = q.get("invite") ?? q.get("code");
    return { url: h.origin, invite: invite && /^[\w-]{1,64}$/.test(invite) ? invite : null };
  } catch {
    return null;
  }
}
let pendingJoin: JoinLink | null = parseJoin(process.argv);

const isSafeExternal = (url: unknown): url is string => {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

function registerIpc(): void {
  ipcMain.handle("hosts:list", () => hosts.list());
  ipcMain.handle("hosts:save", (_e, h) => hosts.save(h));
  ipcMain.handle("hosts:remove", (_e, url) => hosts.remove(url));
  ipcMain.handle("hosts:getToken", (_e, url) => hosts.getToken(url));
  ipcMain.handle("hosts:setToken", (_e, url, token) => hosts.setToken(url, token));
  ipcMain.handle("hosts:getLast", () => hosts.getLast());
  ipcMain.handle("hosts:setLast", (_e, url) => hosts.setLast(url));
  ipcMain.handle("localHost:status", () => ({ ...localHost.status(), port: localHost.status().port ?? hosts.localHostPrefs().port }));
  ipcMain.handle("localHost:start", (_e, port) => localHost.start(port));
  ipcMain.handle("localHost:stop", async () => {
    hostStopped();
    return localHost.stop();
  });
  ipcMain.handle("app:takeJoin", () => {
    const j = pendingJoin;
    pendingJoin = null;
    return j;
  });
  ipcMain.handle("shell:openExternal", (_e, url) => (isSafeExternal(url) ? shell.openExternal(url) : undefined));
  registerMediaIpc(() => mainWindow);
  registerNetIpc();
  registerRemoteIpc();
  registerTray(() => mainWindow);
  registerServices(() => mainWindow);
}

/*
 * Start menu / desktop / pinned taskbar shortcuts point their icon at resources/icon.ico (not the exe,
 * whose cached icon may be Electron's), once per version; then the shell icon cache is refreshed.
 */
function fixShortcutIcons(ico: string): void {
  const marker = path.join(app.getPath("userData"), "shortcut-icons.txt");
  try {
    if (fs.readFileSync(marker, "utf8") === app.getVersion()) return;
  } catch { /* first run */ }
  const appData = process.env.APPDATA ?? "";
  const links = [
    path.join(appData, "Microsoft/Windows/Start Menu/Programs/NooXCord.lnk"),
    path.join(app.getPath("desktop"), "NooXCord.lnk"),
    path.join(appData, "Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/NooXCord.lnk"),
  ];
  for (const lnk of links) {
    try {
      if (!fs.existsSync(lnk)) continue;
      const cur = shell.readShortcutLink(lnk);
      if (path.resolve(cur.target).toLowerCase() !== path.resolve(process.execPath).toLowerCase()) continue;
      shell.writeShortcutLink(lnk, "update", { target: cur.target, icon: ico, iconIndex: 0, appUserModelId: AUMID });
    } catch { /* shortcut unreadable: leave it */ }
  }
  // Rebuilds the per-user icon cache entries (no admin); harmless if it fails.
  execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "ie4uinit.exe"), ["-show"], { windowsHide: true }, () => {});
  try { fs.writeFileSync(marker, app.getVersion()); } catch { /* read-only profile */ }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: "#0B0D11",
    title: "NooXCord",
    // Windows cannot load an .ico from inside app.asar (the taskbar fell back to the Electron icon): packaged copy sits next to app.asar.
    icon: app.isPackaged ? path.join(process.resourcesPath, "icon.ico") : path.join(__dirname, "../resources/icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // Taskbar button icon. Windows caches icons per file path: NooXCord.exe once carried the Electron icon
  // and the shell kept showing it after updates. A separate .ico path is never in that cache.
  if (process.platform === "win32" && app.isPackaged) {
    const ico = path.join(process.resourcesPath, "icon.ico");
    mainWindow.setAppDetails({ appId: AUMID, appIconPath: ico, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: "NooXCord" });
    fixShortcutIcons(ico);
  }
  if (!process.env.NX_SELFTEST && !startHidden()) mainWindow.once("ready-to-show", () => mainWindow?.show());
  // Close to tray (setting, default on): the app keeps running for voice, hosting and notifications.
  mainWindow.on("close", (e) => {
    if (process.env.NX_SELFTEST || isQuitting() || !hosts.appPrefs().closeToTray) return;
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("focus", () => mainWindow?.flashFrame(false));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Never navigate the app window away from the client.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (process.env.NX_DEV_URL && url.startsWith(process.env.NX_DEV_URL)) return;
    e.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });

  const devUrl = process.env.NX_DEV_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(app.isPackaged ? path.join(process.resourcesPath, "web/index.html") : path.join(__dirname, "../../../packages/client/dist/index.html"));
}

app.on("second-instance", (_e, argv) => {
  showMain();
  const join = parseJoin(argv);
  if (join) mainWindow?.webContents.send("app:join", join);
});

/** Headless check used during development: NX_SELFTEST=1 electron . */
async function selfTest(): Promise<void> {
  const log = (...a: unknown[]) => console.log("[selftest]", ...a);
  const port = Number(process.env.NX_SELFTEST_PORT ?? 47831);
  const st = await localHost.start(port);
  log("localHost.start", JSON.stringify(st));
  const info = await fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.json());
  log("api/info", JSON.stringify(info));
  const web = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  log("web client served", web.includes('<div id="root">'));
  const url = `http://127.0.0.1:${port}`;
  hosts.setToken(url, "secret-token-123");
  log("safeStorage roundtrip", hosts.getToken(url) === "secret-token-123");
  hosts.remove(url);
  const busy = await new Promise<string>((res) => {
    void localHost.stop().then(async () => {
      const net = await import("node:net");
      const srv = net.createServer().listen(port, "0.0.0.0", () => {
        void localHost.start(port).then((s) => { srv.close(); res(s.error ?? "no error"); });
      });
    });
  });
  log("port-in-use error", busy);
  // Faz 3: port check (all of 0.0.0.0, ::, 127.0.0.1), suggestion, addresses. Opens no tunnel.
  const { checkPort, suggestPort, addresses } = await import("./network");
  const net2 = await import("node:net");
  const held = net2.createServer().listen(port, "::");
  await new Promise((r) => held.once("listening", r));
  log("checkPort busy (IPv6 holder)", JSON.stringify(await checkPort(port, null)));
  held.close();
  log("checkPort free", JSON.stringify(await checkPort(port + 10, null)));
  log("checkPort privileged", (await checkPort(80, null)).status);
  log("suggestPort", await suggestPort());
  log("addresses", JSON.stringify(await addresses()));
  await localHost.stop();
  log("done");
  app.exit(0);
}

/** Renders the real window off-screen, drives the preload bridge and saves a screenshot (NX_SHOT). */
async function uiSelfTest(): Promise<void> {
  const log = (...a: unknown[]) => console.log("[uitest]", ...a);
  createMainWindow();
  const wc = mainWindow!.webContents;
  await new Promise<void>((r) => wc.once("did-finish-load", () => r()));
  await new Promise((r) => setTimeout(r, 2500));
  log("bridge", await wc.executeJavaScript("JSON.stringify({ nx: !!window.nx, platform: window.nx?.platform })"));
  log("screen text", await wc.executeJavaScript("document.body.innerText.slice(0, 120).replace(/\\n/g, ' | ')"));
  if (process.env.NX_UITEST_HOST) {
    const h = JSON.stringify(process.env.NX_UITEST_HOST);
    log("origin", await wc.executeJavaScript("location.origin"));
    log("cross-origin fetch", await wc.executeJavaScript(`fetch(${h} + "/api/info").then(r => r.json()).then(j => j.name, e => "FAIL " + e)`));
    log("cross-origin websocket", await wc.executeJavaScript(`new Promise(res => { const ws = new WebSocket(${h}.replace("http", "ws") + "/ws"); ws.onopen = () => { ws.close(); res("open"); }; ws.onerror = () => res("FAIL"); })`));
  }
  // Optional: sign in with a token and run a script (e.g. open a settings page) before the shot.
  if (process.env.NX_UITEST_HOST && process.env.NX_UITEST_TOKEN) {
    const h = JSON.stringify(process.env.NX_UITEST_HOST);
    await wc.executeJavaScript(`window.nx.hosts.setToken(${h}, ${JSON.stringify(process.env.NX_UITEST_TOKEN)}).then(() => window.nx.hosts.setLast(${h}))`);
    wc.reload();
    await new Promise<void>((r) => wc.once("did-finish-load", () => r()));
    await new Promise((r) => setTimeout(r, 2500));
  }
  // Optional: fake an update state ("downloading" / "ready") to see the corner popup.
  if (process.env.NX_UITEST_UPDATE) {
    const status = process.env.NX_UITEST_UPDATE;
    wc.send("updates:state", { status, current: app.getVersion(), version: "9.9.9", pct: 42 });
    await wc.executeJavaScript("document.getAnimations().forEach((a) => a.finish())"); // hidden windows do not tick CSS animations
    await new Promise((r) => setTimeout(r, 300));
  }
  if (process.env.NX_UITEST_JS) {
    log("script", await wc.executeJavaScript(process.env.NX_UITEST_JS).catch((e: Error) => "FAIL " + e.message));
    await new Promise((r) => setTimeout(r, 2500));
  }
  const img = await wc.capturePage();
  if (process.env.NX_SHOT) (await import("node:fs")).writeFileSync(process.env.NX_SHOT, img.toPNG());
  log("captured", img.getSize());
  app.exit(0);
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (app.isPackaged) app.setAsDefaultProtocolClient("nooxcord"); // the installer does it too; keeps it after a move
  registerIpc();
  if (process.env.NX_SELFTEST === "1") return void selfTest();
  if (process.env.NX_SELFTEST === "ui") return void uiSelfTest();
  if (process.env.NX_SELFTEST === "voice") return void voiceSelfTest();
  const prefs = hosts.localHostPrefs();
  if (prefs.autoStart) await localHost.start(prefs.port); // resume hosting before the UI reconnects
  createMainWindow();
  createTray();
  registerOverlay();
  registerNetShortcuts();
});

app.on("before-quit", () => {
  markQuitting();
  destroyTray();
  endRemote();
  shutdownMedia();
  shutdownNet();
  destroyOverlay();
  localHost.shutdown();
});
app.on("window-all-closed", () => app.quit());
