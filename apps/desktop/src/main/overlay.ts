import path from "node:path";
import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";

/*
 * In-game overlay (CLAUDE.md §8): transparent, click-through, always-on-top window listing the
 * people in your voice channel. Speaking = green ring + full opacity; others dimmed; "YAYINDA" badge.
 * Works over borderless/windowed games. Shown only while in voice; Ctrl+Shift+O hides/shows it.
 */

interface OverlayMember {
  id: string;
  name: string;
  avatar: string | null;
  self: boolean;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  live: boolean;
}

let overlay: BrowserWindow | null = null;
let members: OverlayMember[] | null = null;
let userHidden = false;

const ROW = 34;
const WIDTH = 280;

const html = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src http: https: data:">
<style>
  html,body{margin:0;background:transparent;font:600 13px "Segoe UI",system-ui,sans-serif;overflow:hidden;user-select:none}
  .list{display:flex;flex-direction:column;gap:6px;padding:8px}
  .m{display:flex;align-items:center;gap:8px;opacity:.45;transition:opacity .12s;height:28px}
  .m.speaking{opacity:1}
  .av{position:relative;width:26px;height:26px;border-radius:50%;background:#1f2430;border:2px solid transparent;flex:none;
      display:grid;place-items:center;color:#e8ecf2;font-size:11px;font-weight:800;overflow:hidden;transition:border-color .1s,box-shadow .1s}
  .av img{width:100%;height:100%;object-fit:cover}
  .m.speaking .av{border-color:#3ddc84;box-shadow:0 0 8px #3ddc8488}
  .n{color:#e8ecf2;text-shadow:0 1px 2px #000,0 0 4px #000;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
  .m.speaking .n{font-weight:700}
  .live{display:inline-flex;align-items:center;gap:4px;background:#ff3b5c;color:#fff;font-size:10px;font-weight:800;letter-spacing:.04em;padding:1px 6px;border-radius:4px;flex:none}
  .live::before{content:"";width:6px;height:6px;border-radius:50%;background:#fff}
  .ic{width:14px;height:14px;color:#ff3b5c;flex:none;filter:drop-shadow(0 1px 1px #000)}
</style></head><body><div class="list" id="l"></div><script>
  const l = document.getElementById("l");
  const MIC = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 11.5 5.3M19 11v0M12 18v3M4 4l16 16"/></svg>';
  const HP = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 15v-3a8 8 0 0 1 13.7-5.6M20 12v3M4 4l16 16"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  window.nxOverlay.onState((list) => {
    l.innerHTML = (list || []).map((m) =>
      '<div class="m' + (m.speaking ? ' speaking' : '') + '"><div class="av">' +
      (m.avatar && /^https?:/.test(m.avatar) ? '<img src="' + esc(m.avatar) + '">' : esc((m.name || "?").slice(0, 1).toUpperCase())) +
      '</div><span class="n">' + esc(m.name) + (m.self ? ' (sen)' : '') + '</span>' +
      (m.live ? '<span class="live">YAYINDA</span>' : '') + (m.muted ? MIC : '') + (m.deafened ? HP : '') + '</div>').join("");
  });
</script></body></html>`;

function ensureWindow(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: workArea.x + 16,
    y: workArea.y + 16,
    width: WIDTH,
    height: 60,
    transparent: true,
    frame: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, "overlay-preload.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.on("will-navigate", (e) => e.preventDefault());
  void overlay.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  overlay.webContents.on("did-finish-load", () => overlay?.webContents.send("overlay:state", members));
  return overlay;
}

function sync() {
  const list = members;
  if (!list || list.length === 0 || userHidden) {
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide();
    if (!list && overlay && !overlay.isDestroyed()) {
      overlay.destroy(); // not in voice: no window, no rendering
      overlay = null;
    }
    return;
  }
  const win = ensureWindow();
  win.setSize(WIDTH, 16 + list.length * ROW);
  win.webContents.send("overlay:state", list);
  if (!win.isVisible()) {
    win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");
  }
}

export function registerOverlay(): void {
  ipcMain.on("overlay:update", (_e, list: unknown) => {
    members = Array.isArray(list) ? (list as OverlayMember[]).slice(0, 25) : null;
    sync();
  });
  globalShortcut.register("CommandOrControl+Shift+O", () => {
    userHidden = !userHidden;
    sync();
  });
}

export function destroyOverlay(): void {
  overlay?.destroy();
  overlay = null;
}
