import os from "node:os";
import { BrowserWindow, MessageChannelMain, desktopCapturer, ipcMain, screen, session, type MessagePortMain, type WebContents } from "electron";

/*
 * Desktop media helpers for the renderer:
 *  - screen/window picker (desktopCapturer) + setDisplayMediaRequestHandler
 *  - system audio WITHOUT NooXCord's own sound (native WASAPI process loopback, exclude our tree)
 *  - global push-to-talk (key polling in the main process, works while a game has focus)
 */

interface NativeModule {
  loopbackStart(excludePid: number): { sampleRate: number; channels: number };
  loopbackRead(): Float32Array;
  loopbackStop(): void;
  keyDown(vk: number): boolean;
}

let native: NativeModule | null = null;
let nativeError: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require("@nooxcord/native") as { native: NativeModule | null; loadError: unknown };
  native = m.native;
  if (!native) nativeError = String(m.loadError);
} catch (e) {
  nativeError = String(e);
}

let pendingSource: string | null = null;
let audio: { port: MessagePortMain; timer: NodeJS.Timeout; owner: WebContents } | null = null;
let ptt: { vk: number; down: boolean; timer: NodeJS.Timeout; owner: WebContents } | null = null;

/** Windows 10 2004 (build 19041) added process loopback. */
const loopbackOs = (): boolean => {
  if (process.platform !== "win32") return false;
  const build = Number(os.release().split(".")[2] ?? 0);
  return build >= 19041;
};

/** KeyboardEvent.code -> Windows virtual-key code. */
function vkFromCode(code: string): number | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!.charCodeAt(0);
  m = /^Digit([0-9])$/.exec(code);
  if (m) return 0x30 + Number(m[1]);
  m = /^F([0-9]{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 0x6f + Number(m[1]);
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return 0x60 + Number(m[1]);
  const table: Record<string, number> = {
    Space: 0x20, Tab: 0x09, CapsLock: 0x14, Backquote: 0xc0, Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd,
    Backslash: 0xdc, Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf, IntlBackslash: 0xe2,
    ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
    Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27, Pause: 0x13, ScrollLock: 0x91,
    NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadMultiply: 0x6a, NumpadDivide: 0x6f, NumpadDecimal: 0x6e,
    // mouse side buttons are common PTT choices
    Mouse4: 0x05, Mouse5: 0x06,
  };
  return table[code] ?? null;
}

function stopAudio() {
  if (!audio) return;
  clearInterval(audio.timer);
  audio.port.close();
  audio = null;
  try { native?.loopbackStop(); } catch { /* ignore */ }
}

function stopPtt() {
  if (!ptt) return;
  clearInterval(ptt.timer);
  ptt = null;
}

export function registerMediaIpc(getMain: () => BrowserWindow | null): void {
  // getDisplayMedia() in the renderer resolves to the source picked in our own UI.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const id = pendingSource;
    pendingSource = null;
    if (!id) return callback({});
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => s.id === id);
    callback(src ? { video: src } : {});
  });

  ipcMain.handle("media:getSources", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay().id;
    const ownTitles = new Set(BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    return sources
      .filter((s) => s.id.startsWith("screen:") || !ownTitles.has(s.name)) // never offer our own windows
      .map((s) => {
        const d = s.display_id ? displays.find((x) => String(x.id) === s.display_id) : undefined;
        return {
          id: s.id,
          name: s.name,
          kind: s.id.startsWith("screen:") ? "screen" : "window",
          thumbnail: s.thumbnail.toDataURL(),
          appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
          width: d ? Math.round(d.size.width * d.scaleFactor) : null,
          height: d ? Math.round(d.size.height * d.scaleFactor) : null,
          refreshRate: d?.displayFrequency ? Math.round(d.displayFrequency) : null,
          primary: d?.id === primary,
        };
      });
  });

  ipcMain.handle("media:selectSource", (_e, id: unknown) => {
    pendingSource = typeof id === "string" ? id : null;
  });

  ipcMain.handle("media:systemAudioSupported", () => !!native && loopbackOs());

  ipcMain.handle("media:startSystemAudio", (e) => {
    stopAudio();
    if (!native || !loopbackOs()) return { ok: false, sampleRate: 0, channels: 0, error: nativeError ?? "Windows 10 2004+ gerekli" };
    let info: { sampleRate: number; channels: number };
    try {
      // Exclude the whole NooXCord process tree: renderers, audio service, host — nobody hears themselves.
      info = native.loopbackStart(process.pid);
    } catch (err) {
      return { ok: false, sampleRate: 0, channels: 0, error: (err as Error).message };
    }
    const { port1, port2 } = new MessageChannelMain();
    const owner = e.sender;
    const timer = setInterval(() => {
      if (owner.isDestroyed()) return stopAudio();
      const pcm = native!.loopbackRead();
      if (pcm.length) port1.postMessage(pcm);
    }, 10);
    audio = { port: port1, timer, owner };
    port1.start();
    owner.postMessage("media:sysaudio-port", null, [port2]);
    return { ok: true, ...info };
  });

  ipcMain.handle("media:stopSystemAudio", () => stopAudio());

  ipcMain.handle("media:setPttKey", (e, code: unknown) => {
    stopPtt();
    if (typeof code !== "string" || !native) return;
    const vk = vkFromCode(code);
    if (vk === null) return;
    const owner = e.sender;
    const state = { vk, down: false, owner, timer: setInterval(() => {
      if (owner.isDestroyed()) return stopPtt();
      let down = false;
      try { down = native!.keyDown(vk); } catch { /* ignore */ }
      if (down !== state.down) {
        state.down = down;
        owner.send("media:ptt", down);
      }
    }, 15) };
    ptt = state;
  });

  ipcMain.handle("media:setInCall", (_e, active: unknown) => {
    // Keep timers and audio processing at full speed while in a call, even when minimised.
    getMain()?.webContents.setBackgroundThrottling(!active);
  });
}

export function shutdownMedia(): void {
  stopAudio();
  stopPtt();
}
