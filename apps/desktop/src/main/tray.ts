import path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import { hosts } from "./hosts";
import { s, setLang } from "./strings";

/*
 * Tray icon (CLAUDE.md §12.3): quick mute/deafen, close-to-tray, start with Windows, quit.
 * The icon shows the call state (muted / live). Also the window-level helpers used by notifications.
 */

interface CallState { inVoice: boolean; muted: boolean; deafened: boolean; live: boolean }

let tray: Tray | null = null;
let state: CallState = { inVoice: false, muted: false, deafened: false, live: false };
let quitting = false;
let getWin: () => BrowserWindow | null = () => null;

const res = (f: string) => path.join(__dirname, "../resources", f);
export const isQuitting = (): boolean => quitting;
export const markQuitting = (): void => { quitting = true; };
/** Launched by Windows at sign-in: start in the tray. */
export const startHidden = (): boolean => process.argv.includes("--hidden");

export function showMain(): void {
  const w = getWin();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function send(action: "mute" | "deafen") {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send("tray:action", action);
}

function refresh(): void {
  if (!tray) return;
  const icon = state.live ? "tray-live.png" : state.inVoice && (state.muted || state.deafened) ? "tray-muted.png" : "tray.png";
  tray.setImage(nativeImage.createFromPath(res(icon)));
  tray.setToolTip(state.inVoice ? `NooXCord · ${s(state.live ? "main.tray.live" : "main.tray.inVoice")}` : "NooXCord");
  const prefs = hosts.appPrefs();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: s("main.tray.show"), click: showMain },
    { type: "separator" },
    { label: s("main.tray.mute"), type: "checkbox", checked: state.muted, enabled: state.inVoice, click: () => send("mute") },
    { label: s("main.tray.deafen"), type: "checkbox", checked: state.deafened, enabled: state.inVoice, click: () => send("deafen") },
    { type: "separator" },
    { label: s("main.tray.closeToTray"), type: "checkbox", checked: prefs.closeToTray, click: (i) => setPrefs({ closeToTray: i.checked }) },
    { label: s("main.tray.openAtLogin"), type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, enabled: app.isPackaged, click: (i) => setPrefs({ openAtLogin: i.checked }) },
    { type: "separator" },
    { label: s("main.tray.quit"), click: () => { quitting = true; app.quit(); } },
  ]));
}

export interface AppPrefsView { closeToTray: boolean; openAtLogin: boolean; lang: "tr" | "en"; canOpenAtLogin: boolean }

function prefsView(): AppPrefsView {
  const p = hosts.appPrefs();
  return { closeToTray: p.closeToTray, lang: p.lang, openAtLogin: app.getLoginItemSettings().openAtLogin, canOpenAtLogin: app.isPackaged };
}

function setPrefs(p: Partial<{ closeToTray: boolean; openAtLogin: boolean; lang: "tr" | "en" }>): AppPrefsView {
  const next: Partial<{ closeToTray: boolean; lang: "tr" | "en" }> = {};
  if (typeof p.closeToTray === "boolean") next.closeToTray = p.closeToTray;
  if (p.lang === "tr" || p.lang === "en") {
    next.lang = p.lang;
    setLang(p.lang);
  }
  hosts.setAppPrefs(next);
  // Only the installed app registers itself (a dev build would register electron.exe).
  if (typeof p.openAtLogin === "boolean" && app.isPackaged) app.setLoginItemSettings({ openAtLogin: p.openAtLogin, args: ["--hidden"] });
  refresh();
  return prefsView();
}

export function registerTray(win: () => BrowserWindow | null): void {
  getWin = win;
  setLang(hosts.appPrefs().lang);
  ipcMain.handle("app:getPrefs", () => prefsView());
  ipcMain.handle("app:setPrefs", (_e, p: unknown) => setPrefs((p && typeof p === "object" ? p : {}) as Parameters<typeof setPrefs>[0]));
  ipcMain.handle("app:focus", () => showMain());
  ipcMain.handle("app:attention", () => {
    const w = getWin();
    if (w && !w.isFocused()) w.flashFrame(true);
  });
  ipcMain.on("tray:state", (_e, st: unknown) => {
    const v = (st ?? {}) as Partial<CallState>;
    state = { inVoice: !!v.inVoice, muted: !!v.muted, deafened: !!v.deafened, live: !!v.live };
    refresh();
  });
}

export function createTray(): void {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(res("tray.png")));
  tray.on("click", showMain);
  refresh();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
