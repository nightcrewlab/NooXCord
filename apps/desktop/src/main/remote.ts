import { BrowserWindow, globalShortcut, ipcMain, screen, type WebContents } from "electron";
import { currentShareTarget, native, vkFromCode, type ShareTarget } from "./media";

/*
 * Remote control, streamer side (CLAUDE.md §7). The renderer receives input from the host (only from
 * the current controller) and hands it here; we map normalised coordinates onto the shared monitor or
 * window and inject with SendInput (packages/native).
 * Safety (§7.3): visible frame + badge while active, panic shortcut, the streamer's own input wins for
 * 2 s, Windows keys are never injected, keys reach a shared window only while it has focus, and every
 * held key/button is released when control ends.
 */

export type RemoteEvent =
  | { k: "m"; x: number; y: number }
  | { k: "b"; b: number; d: boolean }
  | { k: "w"; dx: number; dy: number }
  | { k: "k"; c: string; d: boolean };

const PANIC = "Ctrl+Alt+Shift+Escape";
const LOCAL_PRIORITY_MS = 2000;
const BLOCKED_KEYS = new Set(["MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

interface Session {
  owner: WebContents;
  target: ShareTarget;
  frame: BrowserWindow | null;
  keys: Set<number>;
  buttons: Set<number>;
  rect: { x: number; y: number; width: number; height: number } | null;
  rectAt: number;
}

let session: Session | null = null;

function targetRect(s: Session): Session["rect"] {
  const now = Date.now();
  if (now - s.rectAt < 500) return s.rect;
  s.rectAt = now;
  if (s.target.kind === "screen") {
    const id = s.target.displayId;
    const d = screen.getAllDisplays().find((x) => String(x.id) === id) ?? screen.getPrimaryDisplay();
    s.rect = screen.dipToScreenRect(null, d.bounds); // physical pixels
  } else {
    s.rect = native?.windowRect?.(s.target.hwnd) ?? null;
  }
  return s.rect;
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Red frame + "X is controlling" badge around the controlled monitor; excluded from the capture. */
function showFrame(target: ShareTarget, label: string): BrowserWindow | null {
  let bounds: Electron.Rectangle;
  if (target.kind === "screen") {
    const d = screen.getAllDisplays().find((x) => String(x.id) === target.displayId) ?? screen.getPrimaryDisplay();
    bounds = d.bounds;
  } else {
    const r = native?.windowRect?.(target.hwnd);
    bounds = r ? screen.screenToDipRect(null, r) : screen.getPrimaryDisplay().bounds;
  }
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  win.setContentProtection(true); // WDA_EXCLUDEFROMCAPTURE: viewers never see the frame
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:600 13px "Segoe UI",system-ui,sans-serif}
.f{position:fixed;inset:0;border:3px solid #ff3b5c;box-sizing:border-box}
.b{position:fixed;top:0;left:50%;transform:translateX(-50%);background:#ff3b5c;color:#fff;padding:5px 14px;border-radius:0 0 10px 10px;white-space:nowrap}</style>
<div class="f"></div><div class="b">${esc(label)}</div>`;
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

function releaseAll(s: Session): void {
  for (const vk of s.keys) try { native?.inputKey?.(vk, false); } catch { /* ignore */ }
  for (const b of s.buttons) try { native?.inputButton?.(b, false); } catch { /* ignore */ }
  s.keys.clear();
  s.buttons.clear();
}

export function endRemote(notify = false): void {
  const s = session;
  if (!s) return;
  session = null;
  releaseAll(s);
  try { native?.inputGuardStop?.(); } catch { /* ignore */ }
  globalShortcut.unregister(PANIC);
  if (s.frame && !s.frame.isDestroyed()) s.frame.destroy();
  if (notify && !s.owner.isDestroyed()) s.owner.send("remote:panic");
}

function begin(owner: WebContents, label: string): { ok: boolean; error?: string } {
  endRemote();
  const target = currentShareTarget();
  if (!native?.inputMove || !native.inputGuardStart) return { ok: false, error: "native" };
  if (!target) return { ok: false, error: "no_share" };
  try {
    native.inputGuardStart();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  session = { owner, target, frame: null, keys: new Set(), buttons: new Set(), rect: null, rectAt: 0 };
  session.frame = showFrame(target, label);
  // Panic: ends control at once, whatever has focus.
  globalShortcut.register(PANIC, () => endRemote(true));
  owner.once("destroyed", () => endRemote());
  return { ok: true };
}

function apply(ev: RemoteEvent[]): void {
  const s = session;
  if (!s || !native) return;
  // The streamer's own input always wins: ignore presses/moves for 2 s after they touch anything.
  const localActive = (native.physicalIdleMs?.() ?? Infinity) < LOCAL_PRIORITY_MS;
  const isWindow = s.target.kind === "window";
  const focused = !isWindow || native.foregroundWindow?.() === (s.target as { hwnd: number }).hwnd;
  for (const e of ev) {
    try {
      if (e.k === "k") {
        if (BLOCKED_KEYS.has(e.c)) continue;
        const vk = vkFromCode(e.c);
        if (vk === null || vk === 0x05 || vk === 0x06) continue; // mouse side buttons are not keys here
        if (e.d) {
          if (localActive || !focused) continue;
          s.keys.add(vk);
        } else {
          if (!s.keys.delete(vk)) continue; // never release what we did not press
        }
        native.inputKey?.(vk, e.d);
      } else if (e.k === "b") {
        if (e.d) {
          if (localActive) continue;
          s.buttons.add(e.b);
        } else if (!s.buttons.delete(e.b)) continue;
        native.inputButton?.(e.b, e.d);
      } else if (e.k === "m") {
        if (localActive) continue;
        const r = targetRect(s);
        if (!r || r.width <= 0 || r.height <= 0) continue;
        const x = r.x + Math.min(r.width - 1, Math.max(0, Math.round(e.x * r.width)));
        const y = r.y + Math.min(r.height - 1, Math.max(0, Math.round(e.y * r.height)));
        native.inputMove?.(x, y);
      } else if (e.k === "w") {
        if (localActive || !focused) continue;
        native.inputWheel?.(e.dx, e.dy);
      }
    } catch {
      /* one bad event must not break the session */
    }
  }
}

export function registerRemoteIpc(): void {
  ipcMain.handle("remote:supported", () => !!native?.inputMove && process.platform === "win32");
  ipcMain.handle("remote:begin", (e, label: unknown) => begin(e.sender, typeof label === "string" ? label.slice(0, 120) : ""));
  ipcMain.handle("remote:end", () => endRemote());
  ipcMain.on("remote:input", (e, ev: unknown) => {
    if (!session || e.sender !== session.owner || !Array.isArray(ev)) return;
    apply(ev.slice(0, 64) as RemoteEvent[]);
  });
}
