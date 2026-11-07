import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, net, shell } from "electron";

/*
 * Tunnel providers (CLAUDE.md §10.4, ADR 0001). Both run as child processes we own:
 *   cloudflare: Cloudflare Quick Tunnel, no account, new random URL on every start (default)
 *   devtunnel:  Microsoft Dev Tunnels, GitHub login once, fixed URL per tunnel id (optional)
 */

export type TunnelProviderId = "cloudflare" | "devtunnel";
export type TunnelStatus = "off" | "starting" | "on" | "error";

export interface DevTunnelInfo {
  installed: boolean;
  user: string | null; // GitHub login, null = not logged in
  login: { code: string; url: string } | null; // device-code login in progress
  busy: boolean;
}

export interface TunnelState {
  provider: TunnelProviderId;
  status: TunnelStatus;
  url: string | null;
  error: string | null;
  log: string[];
  dev: DevTunnelInfo;
}

export interface TunnelPrefs {
  provider: TunnelProviderId;
  devTunnelId: string | null;
}

interface Hooks {
  prefs(): TunnelPrefs;
  setPrefs(p: Partial<TunnelPrefs>): void;
  onState(s: TunnelState): void;
  /** A new public URL appeared (notify + maybe copy). */
  onUrl(url: string): void;
}

const CF_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DEV_DOWNLOAD = "https://aka.ms/TunnelsCliDownload/win-x64";

const devBin = () => path.join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "NooXCord", "bin", "devtunnel.exe");
const cfBin = () =>
  app.isPackaged ? path.join(process.resourcesPath, "bin", "cloudflared.exe") : path.join(__dirname, "../../../.tools/cloudflared.exe");

const run = (file: string, args: string[], timeout = 30_000) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(file, args, { timeout, windowsHide: true }, (e, out, err) => resolve({ ok: !e, out: `${out ?? ""}${err ?? ""}` })),
  );

export class TunnelManager {
  private state: TunnelState;
  private child: ChildProcess | null = null;
  private port = 0;
  private wanted = false;
  private retry = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(private hooks: Hooks) {
    this.state = {
      provider: hooks.prefs().provider,
      status: "off",
      url: null,
      error: null,
      log: [],
      dev: { installed: fs.existsSync(devBin()), user: null, login: null, busy: false },
    };
  }

  get(): TunnelState {
    return this.state;
  }

  private set(p: Partial<TunnelState>) {
    this.state = { ...this.state, ...p };
    this.hooks.onState(this.state);
  }

  private setDev(p: Partial<DevTunnelInfo>) {
    this.set({ dev: { ...this.state.dev, ...p } });
  }

  private log(line: string) {
    const clean = line.replace(/\s+$/, "");
    if (!clean) return;
    this.state.log = [...this.state.log, clean].slice(-60);
  }

  setProvider(p: TunnelProviderId): void {
    if (p === this.state.provider) return;
    const wasOn = this.wanted;
    this.stop();
    this.hooks.setPrefs({ provider: p });
    this.set({ provider: p, error: null });
    if (p === "devtunnel") void this.refreshDev();
    if (wasOn && this.port) void this.start(this.port);
  }

  async start(port: number): Promise<void> {
    this.stopChild();
    this.wanted = true;
    this.port = port;
    this.set({ status: "starting", url: null, error: null, log: [] });
    try {
      if (this.state.provider === "cloudflare") this.startCloudflare();
      else await this.startDevTunnel();
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  stop(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = 0;
    this.stopChild();
    this.set({ status: "off", url: null, error: null });
  }

  /** Host port changed or host restarted. */
  async restart(port: number): Promise<void> {
    if (this.wanted) await this.start(port);
  }

  private stopChild() {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) c.kill();
  }

  private fail(msg: string) {
    this.stopChild();
    this.wanted = false;
    this.set({ status: "error", url: null, error: msg });
  }

  /** Runs the provider process; resolves the URL from its output; restarts with backoff on crash. */
  private spawnTunnel(file: string, args: string[], urlRe: RegExp) {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let found = false;
    this.startTimer = setTimeout(() => {
      if (!found && this.child === child) this.fail("Tünel 45 saniyede açılamadı. İnternet bağlantını kontrol et.");
    }, 45_000);
    const onData = (buf: Buffer) => {
      for (const line of String(buf).split(/\r?\n/)) {
        this.log(line);
        const m = urlRe.exec(line);
        if (m && !found && this.child === child) {
          found = true;
          if (this.startTimer) clearTimeout(this.startTimer);
          this.retry = 0;
          const url = m[0].replace(/\/$/, "");
          const changed = url !== this.state.url;
          this.set({ status: "on", url, error: null });
          if (changed) this.hooks.onUrl(url);
        }
      }
      this.hooks.onState(this.state);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => this.child === child && this.fail(`Tünel başlatılamadı: ${e.message}`));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return;
      // Crashed or dropped: retry with growing delay (2 s ... 60 s).
      const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
      this.log(`[nooxcord] tünel süreci kapandı (kod ${code}); ${Math.round(delay / 1000)} sn sonra yeniden denenecek`);
      this.set({ status: "starting", url: null });
      this.retryTimer = setTimeout(() => void this.start(this.port), delay);
    });
  }

  // ---------- Cloudflare Quick Tunnel ----------

  private startCloudflare() {
    const bin = cfBin();
    if (!fs.existsSync(bin)) throw new Error("cloudflared.exe bulunamadı. Uygulamayı yeniden kurmayı deneyin.");
    // A user's ~/.cloudflared/config.yml would break quick tunnels: hand it our own (non-empty) config.
    const cfg = path.join(app.getPath("userData"), "cloudflared.yml");
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, "# NooXCord quick tunnel: intentionally empty\nno-autoupdate: true\n");
    this.spawnTunnel(bin, ["tunnel", "--no-autoupdate", "--config", cfg, "--url", `http://127.0.0.1:${this.port}`], CF_URL);
  }

  // ---------- Microsoft Dev Tunnels ----------

  async refreshDev(): Promise<DevTunnelInfo> {
    const installed = fs.existsSync(devBin());
    if (!installed) {
      this.setDev({ installed, user: null });
      return this.state.dev;
    }
    const r = await run(devBin(), ["user", "show"]);
    const m = /Logged in as (\S+)/i.exec(r.out);
    this.setDev({ installed, user: m ? m[1]! : null });
    return this.state.dev;
  }

  /** Downloads devtunnel.exe from Microsoft and checks its Authenticode signature before use. */
  async installDev(): Promise<void> {
    if (this.state.dev.busy) return;
    this.setDev({ busy: true });
    try {
      const dest = devBin();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".download";
      const res = await net.fetch(DEV_DOWNLOAD, { redirect: "follow" });
      if (!res.ok) throw new Error(`İndirme başarısız (HTTP ${res.status}).`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      const sig = await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `$s = Get-AuthenticodeSignature -LiteralPath '${tmp.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
      ]);
      if (!/^Valid\|.*O=Microsoft Corporation/m.test(sig.out.trim())) {
        fs.rmSync(tmp, { force: true });
        throw new Error("İndirilen dosyanın Microsoft imzası doğrulanamadı; kullanılmadı.");
      }
      fs.renameSync(tmp, dest);
      this.setDev({ installed: true });
      await this.refreshDev();
    } finally {
      this.setDev({ busy: false });
    }
  }

  /** GitHub device-code login: shows the code, opens the browser, waits for the CLI to finish. */
  async loginDev(): Promise<void> {
    if (!fs.existsSync(devBin()) || this.state.dev.busy) return;
    this.setDev({ busy: true, login: null });
    await new Promise<void>((resolve) => {
      const child = spawn(devBin(), ["user", "login", "-g", "-d"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let opened = false;
      const onData = (b: Buffer) => {
        const s = String(b);
        const url = /(https:\/\/github\.com\/login\/device)/i.exec(s)?.[1];
        const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(s)?.[1];
        if (url && code && !opened) {
          opened = true;
          this.setDev({ login: { code, url } });
          void shell.openExternal(url);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => child.kill(), 10 * 60_000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
      child.on("error", () => { clearTimeout(timer); resolve(); });
    });
    this.setDev({ busy: false, login: null });
    await this.refreshDev();
  }

  async logoutDev(): Promise<void> {
    if (!fs.existsSync(devBin())) return;
    if (this.state.provider === "devtunnel") this.stop();
    await run(devBin(), ["user", "logout"]);
    await this.refreshDev();
  }

  /** Deletes the current tunnel; the next start creates a new id and a new fixed URL. */
  async newDevUrl(): Promise<void> {
    const id = this.hooks.prefs().devTunnelId;
    const wasOn = this.wanted;
    if (this.state.provider === "devtunnel") this.stop();
    if (id && fs.existsSync(devBin())) await run(devBin(), ["delete", id, "--force"]);
    this.hooks.setPrefs({ devTunnelId: null });
    if (wasOn && this.port) await this.start(this.port);
  }

  private async startDevTunnel() {
    const bin = devBin();
    if (!fs.existsSync(bin)) throw new Error("Dev Tunnels aracı kurulu değil. Önce \"Aracı indir\".");
    const info = await this.refreshDev();
    if (!info.user) throw new Error("Dev Tunnels için önce GitHub ile giriş yap.");
    let id = this.hooks.prefs().devTunnelId;
    // Tunnels expire after a while unused: recreate the same id when it is gone.
    if (!id || !(await run(bin, ["show", id])).ok) {
      id ??= `nooxcord-${Math.random().toString(36).slice(2, 8)}`;
      const c = await run(bin, ["create", id, "--allow-anonymous"]);
      this.log(c.out);
      if (!c.ok && !/already exists|Conflict/i.test(c.out)) throw new Error("Dev tunnel oluşturulamadı: " + c.out.trim().split("\n").pop());
      this.hooks.setPrefs({ devTunnelId: id });
    }
    const pc = await run(bin, ["port", "create", id, "-p", String(this.port), "--protocol", "http"]);
    this.log(pc.out);
    if (!this.wanted) return;
    // "Connect via browser" lists https://<id>.<region>.devtunnels.ms:<port> and https://<id>-<port>.<region>...; we want the latter.
    this.spawnTunnel(bin, ["host", id], new RegExp(`https://[a-z0-9-]+-${this.port}\\.[a-z0-9]+\\.devtunnels\\.ms`, "i"));
  }
}
