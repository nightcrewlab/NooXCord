/**
 * Platform adapter. The same client runs in Electron (window.nx from preload) and in a plain browser.
 * Nothing outside this folder may touch window.nx directly.
 */
export interface SavedHost {
  url: string; // normalised origin, e.g. http://192.168.1.20:47820
  name: string;
}

export interface LocalHostStatus {
  running: boolean;
  port: number | null;
  lanAddresses: string[];
  error?: string;
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

export interface BackupInfo { name: string; size: number; at: number }

export interface TrayState { inVoice: boolean; muted: boolean; deafened: boolean; live: boolean }

export interface HostPrefs {
  allowGuests: boolean;
  guestPassword: string;
  copyTunnelUrl: boolean;
}

export type PortStatus = "free" | "in_use" | "own" | "privileged" | "invalid";
export interface PortCheck {
  port: number;
  status: PortStatus;
  process: string | null;
  mediaFree: boolean;
}

export interface NetAddresses {
  lan: { name: string; ip: string }[];
  hamachi: { ip: string | null; service: "running" | "stopped" | "missing" | "unknown" };
  firewall: "allowed" | "missing" | "unknown";
}

export type TunnelProviderId = "cloudflare" | "devtunnel";
export interface TunnelState {
  provider: TunnelProviderId;
  status: "off" | "starting" | "on" | "error";
  url: string | null;
  error: string | null;
  log: string[];
  dev: { installed: boolean; user: string | null; login: { code: string; url: string } | null; busy: boolean };
}

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
  localHost: {
    status(): Promise<LocalHostStatus>;
    start(port: number): Promise<LocalHostStatus>;
    stop(): Promise<LocalHostStatus>;
    restart(port: number): Promise<LocalHostStatus>;
    getPrefs(): Promise<HostPrefs>;
    setPrefs(p: Partial<HostPrefs>): Promise<void>;
  };
  net: {
    checkPort(port: number): Promise<PortCheck>;
    suggestPort(): Promise<number>;
    addresses(): Promise<NetAddresses>;
    hamachiService(start: boolean): Promise<NetAddresses>;
    firewallAllow(): Promise<NetAddresses>;
  };
  tunnel: {
    get(): Promise<TunnelState>;
    setProvider(p: TunnelProviderId): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    copy(): Promise<boolean>;
    devRefresh(): Promise<TunnelState["dev"]>;
    devInstall(): Promise<void>;
    devLogin(): Promise<void>;
    devLogout(): Promise<void>;
    devNewUrl(): Promise<void>;
    onState(cb: (s: TunnelState) => void): () => void;
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
    /** Keep timers/rendering alive while in voice. */
    setInCall(active: boolean): Promise<void>;
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
  };
  updates: {
    get(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    install(): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
  /** Backups of the host database on this computer. */
  backup: {
    list(): Promise<BackupInfo[]>;
    now(): Promise<BackupInfo>;
    /** Save dialog; false when cancelled. */
    export(): Promise<boolean>;
    /** Open dialog + restore (host restarts); false when cancelled. */
    import(): Promise<boolean>;
    restore(name: string): Promise<void>;
    openFolder(): Promise<void>;
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
  localHost: NxBridge["localHost"] | null;
  /** Desktop only: ports, Hamachi, tunnels. */
  net: NxBridge["net"] | null;
  tunnel: NxBridge["tunnel"] | null;
  openExternal(url: string): void;
  /** Desktop-only media helpers; null in the browser. */
  media: NxBridge["media"] | null;
  overlay: NxBridge["overlay"] | null;
  remote: NxBridge["remote"] | null;
  app: NxBridge["app"] | null;
  updates: NxBridge["updates"] | null;
  backup: NxBridge["backup"] | null;
  /** Can this client start a screen share at all? */
  canShareScreen: boolean;
  isMobile: boolean;
}

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
    localHost: null,
    net: null,
    tunnel: null,
    openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    media: null,
    overlay: null,
    remote: null,
    app: null,
    updates: null,
    backup: null,
    canShareScreen: !mobile && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia,
    isMobile: mobile,
  };
}

function desktopPlatform(nx: NxBridge): Platform {
  return {
    kind: "desktop",
    fixedHost: null,
    hosts: nx.hosts,
    localHost: nx.localHost,
    net: nx.net,
    tunnel: nx.tunnel,
    openExternal: (url) => void nx.openExternal(url),
    media: nx.media,
    overlay: nx.overlay,
    remote: nx.remote ?? null,
    app: nx.app ?? null,
    updates: nx.updates ?? null,
    backup: nx.backup ?? null,
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
  if (!/^https?:\/\//i.test(s)) s = (/(trycloudflare\.com|devtunnels\.ms)/i.test(s) ? "https://" : "http://") + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
