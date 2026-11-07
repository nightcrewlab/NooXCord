import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { hosts } from "./hosts";
import * as localHost from "./localHost";
import { destroyOverlay, registerOverlay } from "./overlay";
import { registerMediaIpc, shutdownMedia } from "./media";
import { prepareVoiceTest, voiceSelfTest } from "./voiceTest";

// User data lives in %APPDATA%/NooXCord; self-tests use a throwaway folder.
app.setName("NooXCord");
if (process.env.NX_SELFTEST) app.setPath("userData", path.join(os.tmpdir(), "nooxcord-selftest"));

if (process.env.NX_SELFTEST === "voice") prepareVoiceTest();
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.nooxrii.nooxcord");

let mainWindow: BrowserWindow | null = null;

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
  ipcMain.handle("localHost:stop", () => localHost.stop());
  ipcMain.handle("shell:openExternal", (_e, url) => (isSafeExternal(url) ? shell.openExternal(url) : undefined));
  registerMediaIpc(() => mainWindow);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: "#0B0D11",
    title: "NooXCord",
    icon: path.join(__dirname, "../resources/icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (!process.env.NX_SELFTEST) mainWindow.once("ready-to-show", () => mainWindow?.show());
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

app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
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
  const img = await wc.capturePage();
  if (process.env.NX_SHOT) (await import("node:fs")).writeFileSync(process.env.NX_SHOT, img.toPNG());
  log("captured", img.getSize());
  app.exit(0);
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  if (process.env.NX_SELFTEST === "1") return void selfTest();
  if (process.env.NX_SELFTEST === "ui") return void uiSelfTest();
  if (process.env.NX_SELFTEST === "voice") return void voiceSelfTest();
  const prefs = hosts.localHostPrefs();
  if (prefs.autoStart) await localHost.start(prefs.port); // resume hosting before the UI reconnects
  createMainWindow();
  registerOverlay();
});

app.on("before-quit", () => {
  shutdownMedia();
  destroyOverlay();
  localHost.shutdown();
});
app.on("window-all-closed", () => app.quit());
