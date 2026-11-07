import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Saved hosts and per-host session tokens. Tokens are encrypted with Electron safeStorage
 * (DPAPI on Windows), so they are bound to this Windows user account.
 */
interface SavedHost { url: string; name: string }
interface FileShape {
  hosts: SavedHost[];
  tokens: Record<string, string>; // url -> base64 encrypted token
  last: string | null;
  localHost: LocalHostPrefs;
  app: AppPrefs;
}

export interface AppPrefs {
  /** Closing the window keeps NooXCord running in the tray. */
  closeToTray: boolean;
  lang: "tr" | "en";
}
const DEFAULT_APP: AppPrefs = { closeToTray: true, lang: "tr" };

export interface LocalHostPrefs {
  autoStart: boolean;
  port: number;
  allowGuests: boolean;
  guestPassword: string | null;
  tunnelProvider: "cloudflare" | "devtunnel";
  devTunnelId: string | null;
  /** Copy a new tunnel URL to the clipboard automatically. */
  copyTunnelUrl: boolean;
}

const DEFAULT_LOCAL: LocalHostPrefs = {
  autoStart: false, port: 47820, allowGuests: true, guestPassword: null,
  tunnelProvider: "cloudflare", devTunnelId: null, copyTunnelUrl: true,
};

const file = () => path.join(app.getPath("userData"), "hosts.json");
let cache: FileShape | null = null;

function load(): FileShape {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<FileShape>;
    cache = { hosts: [], tokens: {}, last: null, ...raw, localHost: { ...DEFAULT_LOCAL, ...raw.localHost }, app: { ...DEFAULT_APP, ...raw.app } };
  } catch {
    cache = { hosts: [], tokens: {}, last: null, localHost: { ...DEFAULT_LOCAL }, app: { ...DEFAULT_APP } };
  }
  return cache!;
}

function save(): void {
  const tmp = file() + ".tmp";
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file());
}

const validUrl = (u: unknown): u is string => {
  if (typeof u !== "string" || u.length > 300) return false;
  try {
    const x = new URL(u);
    return (x.protocol === "http:" || x.protocol === "https:") && x.origin === u;
  } catch {
    return false;
  }
};

export const hosts = {
  list: (): SavedHost[] => load().hosts,
  save(h: unknown): void {
    const v = h as SavedHost;
    if (!v || !validUrl(v.url) || typeof v.name !== "string") return;
    const d = load();
    d.hosts = [{ url: v.url, name: v.name.slice(0, 80) }, ...d.hosts.filter((x) => x.url !== v.url)].slice(0, 20);
    save();
  },
  remove(url: unknown): void {
    if (!validUrl(url)) return;
    const d = load();
    d.hosts = d.hosts.filter((x) => x.url !== url);
    delete d.tokens[url];
    if (d.last === url) d.last = null;
    save();
  },
  getToken(url: unknown): string | null {
    if (!validUrl(url)) return null;
    const enc = load().tokens[url];
    if (!enc || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return null;
    }
  },
  setToken(url: unknown, token: unknown): void {
    if (!validUrl(url)) return;
    const d = load();
    if (typeof token === "string" && token.length < 300 && safeStorage.isEncryptionAvailable()) {
      d.tokens[url] = safeStorage.encryptString(token).toString("base64");
    } else delete d.tokens[url];
    save();
  },
  getLast: (): string | null => load().last,
  setLast(url: unknown): void {
    load().last = validUrl(url) ? url : null;
    save();
  },
  appPrefs: () => load().app,
  setAppPrefs(p: Partial<AppPrefs>): void {
    const d = load();
    d.app = { ...d.app, ...p };
    save();
  },
  localHostPrefs: () => load().localHost,
  setLocalHostPrefs(p: Partial<LocalHostPrefs>): void {
    const d = load();
    d.localHost = { ...d.localHost, ...p };
    save();
  },
};
