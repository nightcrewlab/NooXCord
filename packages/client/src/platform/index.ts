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
  openExternal(url: string): void;
  /** Desktop-only media helpers; null in the browser. */
  media: NxBridge["media"] | null;
  overlay: NxBridge["overlay"] | null;
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
    openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    media: null,
    overlay: null,
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
    openExternal: (url) => void nx.openExternal(url),
    media: nx.media,
    overlay: nx.overlay,
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
