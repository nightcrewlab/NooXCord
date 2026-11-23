/**
 * Platform adapter. The same client runs in Electron (window.nx from preload) and in a plain browser.
 * Nothing outside this folder may touch window.nx directly.
 */
export interface SavedHost {
  url: string; // normalised origin, e.g. http://192.168.1.20:47820
  name: string;
}

export interface ScreenSource {
  id: string; // desktopCapturer id, e.g. "screen:0:0" / "window:1234:0"
  name: string;
  kind: "screen" | "window";
  thumbnail: string; // data URL
  appIcon: string | null;
  /** Screens only: native size in physical pixels and refresh rate. */
  width: number | null;
  height: number | null;
  refreshRate: number | null;
  primary: boolean;
}

export interface AppPrefs {
  closeToTray: boolean;
  openAtLogin: boolean;
  lang: "tr" | "en";
  /** Only the installed app can register itself to start with Windows. */
  canOpenAtLogin: boolean;
}

export interface UpdateState {
  status: "idle" | "dev" | "checking" | "none" | "downloading" | "ready" | "error";
  current: string;
  version?: string;
  pct?: number;
  error?: string;
}

export interface TrayState { inVoice: boolean; muted: boolean; deafened: boolean; live: boolean }

/** What the in-game overlay shows (desktop). */
export interface OverlayMember {
  id: string;
  name: string;
  avatar: string | null; // absolute URL
  self: boolean;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  live: boolean;
}

/** Shape of the preload bridge (apps/desktop/src/preload). */
/** nooxcord://join?url=…&invite=… (CLAUDE.md §10.6). */
export interface JoinLink { url: string; invite: string | null }

/** Link that opens this host in the desktop app (shown on the web client). */
export function appJoinLink(hostUrl: string, invite?: string | null): string {
  return `nooxcord://join?url=${encodeURIComponent(hostUrl)}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}`;
}

export interface NxBridge {
  platform: "desktop";
  version: string;
  hosts: {
    list(): Promise<SavedHost[]>;
    save(h: SavedHost): Promise<void>;
    remove(url: string): Promise<void>;
    getToken(url: string): Promise<string | null>;
    setToken(url: string, token: string | null): Promise<void>;
    getLast(): Promise<string | null>;
    setLast(url: string | null): Promise<void>;
  };
  openExternal(url: string): Promise<void>;
  media: {
    getSources(): Promise<ScreenSource[]>;
    /** The next getDisplayMedia() call captures this source. */
    selectSource(id: string): Promise<void>;
    /** System audio excluding NooXCord's own sound (WASAPI process loopback). */
    systemAudioSupported(): Promise<boolean>;
    /** Starts capture; PCM arrives on a MessagePort posted to window as "nx:sysaudio-port". */
    startSystemAudio(): Promise<{ ok: boolean; sampleRate: number; channels: number; error?: string }>;
    stopSystemAudio(): Promise<void>;
    /** Global push-to-talk: the main process watches this key even when the app is not focused. */
    setPttKey(code: string | null): Promise<void>;
    onPtt(cb: (down: boolean) => void): () => void;
    /** Global shortcuts ("Ctrl+Shift+KeyM", "F9", "Mouse4"); the main process fires onHotkey(id) on press. */
    setHotkeys(list: { id: string; combo: string }[]): Promise<void>;
    onHotkey(cb: (id: string) => void): () => void;
    /** Keep timers/rendering alive while in voice. */
    setInCall(active: boolean): Promise<void>;
    /** Diagnostic line in the desktop app's main.log. Optional: older preloads lack it. */
    log?(text: string): void;
  };
  overlay: {
    update(members: OverlayMember[] | null): void;
  };
  app: {
    getPrefs(): Promise<AppPrefs>;
    setPrefs(p: Partial<Pick<AppPrefs, "closeToTray" | "openAtLogin" | "lang">>): Promise<AppPrefs>;
    /** Bring the main window to the front (notification click). */
    focus(): Promise<void>;
    /** Flash the taskbar button when the window is not focused. */
    attention(): Promise<void>;
    openLogs(): Promise<void>;
    setTrayState(s: TrayState): void;
    onTrayAction(cb: (a: "mute" | "deafen") => void): () => void;
    /** nooxcord://join link the app was started with (once). */
    takeJoin?(): Promise<JoinLink | null>;
    /** nooxcord://join link opened while the app runs. */
    onJoin?(cb: (j: JoinLink) => void): () => void;
  };
  updates: {
    get(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    install(): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
  /** Remote control, streamer side: SendInput onto the shared monitor/window (main process). */
  remote: {
    supported(): Promise<boolean>;
    /** Shows the red frame with this label and starts accepting input. */
    begin(label: string): Promise<{ ok: boolean; error?: string }>;
    end(): Promise<void>;
    input(ev: unknown[]): void;
    /** The panic shortcut was pressed (control already stopped locally). */
    onPanic(cb: () => void): () => void;
  };
}

declare global {
  interface Window {
    nx?: NxBridge;
  }
}

export interface Platform {
  kind: "desktop" | "web";
  /** Web: the page's own host is the only host. Desktop: user picks. */
  fixedHost: string | null;
  hosts: NxBridge["hosts"];
  openExternal(url: string): void;
  /** Desktop-only media helpers; null in the browser. */
  media: NxBridge["media"] | null;
  overlay: NxBridge["overlay"] | null;
  remote: NxBridge["remote"] | null;
  app: NxBridge["app"] | null;
  updates: NxBridge["updates"] | null;
  /** Can this client start a screen share at all? */
  canShareScreen: boolean;
  isMobile: boolean;
}

/** The server the desktop app opens by default (set at build time: VITE_NX_DEFAULT_HOST). */
export const DEFAULT_HOST: string | null = normaliseHostUrl((import.meta.env.VITE_NX_DEFAULT_HOST as string | undefined) ?? "");

const mobile = typeof navigator !== "undefined" && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));

const LS = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

function webPlatform(): Platform {
  const fixed = import.meta.env.DEV ? (import.meta.env.VITE_NX_HOST as string | undefined) ?? "http://localhost:47820" : location.origin;
  return {
    kind: "web",
    fixedHost: fixed,
    hosts: {
      list: async () => [{ url: fixed, name: location.hostname }],
      save: async () => {},
      remove: async () => {},
      getToken: async (url) => LS.get(`nx.token:${url}`),
      setToken: async (url, token) => LS.set(`nx.token:${url}`, token),
      getLast: async () => fixed,
      setLast: async () => {},
    },
    openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    media: null,
    overlay: null,
    remote: null,
    app: null,
    updates: null,
    // Phones too where the browser offers it (Android Chrome may; iPhone Safari does not).
    canShareScreen: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function",
    isMobile: mobile,
  };
}

function desktopPlatform(nx: NxBridge): Platform {
  return {
    kind: "desktop",
    fixedHost: null,
    // Nothing chosen yet: the built-in server.
    hosts: { ...nx.hosts, getLast: async () => (await nx.hosts.getLast()) ?? DEFAULT_HOST },
    openExternal: (url) => void nx.openExternal(url),
    media: nx.media,
    overlay: nx.overlay,
    remote: nx.remote ?? null,
    app: nx.app ?? null,
    updates: nx.updates ?? null,
    canShareScreen: true,
    isMobile: false,
  };
}

export const platform: Platform = typeof window !== "undefined" && window.nx ? desktopPlatform(window.nx) : webPlatform();
export const isDesktop = (): boolean => platform.kind === "desktop";

/** Normalises user input like "192.168.1.5:47820" into an origin. */
export function normaliseHostUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  // A bare name is a hosted server (https); an IP address or localhost is a test server (http).
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(s) ? "http://" : "https://") + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Cloudflare quick-tunnel origins are new on every tunnel start, so they are never remembered. */
/** Quick-tunnel addresses change on every start, so they are not worth retrying. */
export function isEphemeralHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

/**
 * Addresses from the self-hosted era (ADR 0003): quick tunnels, dev tunnels and IP/localhost hosts on
 * someone's PC. Release builds skip them on start-up and open the default server instead.
 */
export function isLegacyHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith(".trycloudflare.com") || h.endsWith(".devtunnels.ms") || h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[");
  } catch {
    return false;
  }
}
