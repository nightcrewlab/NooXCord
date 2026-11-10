import {
  CLOSE, PART_SIZE, PING_INTERVAL_MS,
  type AuthResponse, type EventName, type Events, type HostInfo, type MethodName, type MethodParams, type MethodResults,
  type SelfUser, type ServerFrame, type Attachment, type ClientFrame,
} from "@nooxcord/shared";
import { platform } from "../platform";
import { t } from "../i18n";

export class RpcError extends Error {
  constructor(readonly code: string, msg: string) {
    super(msg);
  }
}

export type ConnStatus = "connecting" | "ready" | "reconnecting" | "auth_failed" | "closed";

type Listener = <E extends EventName>(e: E, d: Events[E]) => void;

/** One turn of the event loop; unlike timers it is not throttled in a hidden window. */
const hop = () => new Promise<void>((r) => {
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); r(); };
  c.port2.postMessage(0);
});

/** HTTP helpers against one host. */
export class HostHttp {
  constructor(readonly base: string, public token: string | null = null) {}

  url(p: string | null | undefined): string | undefined {
    if (!p) return undefined;
    return /^https?:/.test(p) ? p : this.base + p;
  }

  private async req<T>(method: string, p: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + p, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RpcError("network", t("err.unreachable"));
    }
    const data = (await res.json().catch(() => ({}))) as { code?: string; msg?: string };
    if (!res.ok) throw new RpcError(data.code ?? "internal", data.msg ?? t("err.server"));
    return data as T;
  }

  info = () => this.req<HostInfo>("GET", "/api/info");
  login = (login: string, password: string) => this.req<AuthResponse>("POST", "/api/auth/login", { login, password });
  guest = (nickname: string, password?: string) => this.req<AuthResponse>("POST", "/api/auth/guest", { nickname, ...(password ? { password } : {}) });
  register = (nickname: string, email: string, password: string) => this.req<AuthResponse>("POST", "/api/auth/register", { nickname, email, password });
  logout = () => this.req<{ ok: true }>("POST", "/api/auth/logout");
  removeAvatar = () => this.req<SelfUser>("DELETE", "/api/me/avatar");

  /** Multipart upload with progress (XHR, since fetch has no upload progress). */
  upload<T = Attachment>(p: string, file: Blob, name: string, fields: Record<string, string> = {}, onProgress?: (pct: number) => void): { promise: Promise<T>; abort: () => void } {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<T>((resolve, reject) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fd.append("file", file, name);
      xhr.open("POST", this.base + p);
      if (this.token) xhr.setRequestHeader("authorization", `Bearer ${this.token}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let data: { code?: string; msg?: string } = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
        else reject(new RpcError(data.code ?? "internal", data.msg ?? t("err.upload")));
      };
      xhr.onerror = () => reject(new RpcError("network", t("err.upload")));
      xhr.onabort = () => reject(new RpcError("aborted", t("err.aborted")));
      xhr.send(fd);
    });
    return { promise, abort: () => xhr.abort() };
  }
}

/**
 * One realtime connection to a host: auth, request/response, events, heartbeat and
 * automatic reconnection with backoff. Re-sends auth and receives a fresh "ready" after reconnect.
 */
export class HostConnection {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: ConnStatus) => void>();
  private pingTimer = 0;
  private retry = 0;
  private lastRecv = 0;
  /** When the oldest still unanswered ping was sent (0 = none outstanding). */
  private pingAt = 0;
  /** The host reassembles split frames (HostInfo.parts, known from "ready"). */
  private canSplit = false;
  private splitQueue: Promise<void> = Promise.resolve();
  private closedByUser = false;
  status: ConnStatus = "connecting";

  constructor(readonly http: HostHttp) {}

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: ConnStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: ConnStatus) {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  connect(): void {
    this.closedByUser = false;
    const wsUrl = this.http.base.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.lastRecv = Date.now();
      this.pingAt = 0;
      this.canSplit = false;
      ws.send(JSON.stringify({ t: "auth", d: { token: this.http.token, client: platform.kind } }));
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        const now = Date.now();
        if (now - this.lastRecv > 12_000) return ws.close(4000, "stale");
        // A ping of ours is unanswered while the host's messages still arrive: the uplink of this socket
        // is stuck. Reconnect now instead of waiting for the host's 15 s. Measured from the ping itself,
        // not from the last pong: in a hidden window this timer runs once a minute, and "last pong is
        // 60 s old" used to close a healthy socket every minute (host.log: "disconnected (4000)").
        if (this.pingAt && now - this.pingAt > 7_000) return ws.close(4000, "stale-up");
        if (ws.readyState !== 1) return;
        if (!this.pingAt) this.pingAt = now;
        ws.send('{"t":"ping"}');
      }, PING_INTERVAL_MS);
    };
    ws.onmessage = (ev) => {
      this.lastRecv = Date.now();
      let f: ServerFrame;
      try { f = JSON.parse(ev.data as string); } catch { return; }
      if (f.t === "ping") return ws.send('{"t":"pong"}');
      if (f.t === "pong") { this.pingAt = 0; return; }
      if (f.t === "res") {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f.d);
        else p.reject(new RpcError(f.e.code, f.e.msg));
        return;
      }
      if (f.t === "evt") {
        if (f.e === "ready") {
          this.retry = 0;
          this.canSplit = !!(f.d as Events["ready"]).host?.parts;
          this.setStatus("ready");
        }
        for (const fn of this.listeners) fn(f.e, f.d as never);
      }
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError("network", t("err.disconnected")));
      }
      this.pending.clear();
      if (this.ws !== ws) return;
      if (this.closedByUser) return this.setStatus("closed");
      if (ev.code === CLOSE.AUTH_FAILED) return this.setStatus("auth_failed");
      this.setStatus("reconnecting");
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      window.setTimeout(() => !this.closedByUser && this.connect(), delay);
    };
  }

  close(): void {
    this.closedByUser = true;
    clearInterval(this.pingTimer);
    this.ws?.close(1000, "bye");
  }

  /**
   * Sends a frame; a long one goes out as small pieces, each in its own TCP segment (see PART_SIZE:
   * full-size segments towards the host get lost over Hamachi and stall the whole connection).
   */
  private sendText(ws: WebSocket, json: string): void {
    if (!this.canSplit || json.length <= PART_SIZE / 2) return ws.send(json);
    // ASCII only, so characters = bytes (JSON allows \u escapes inside strings, the only place they occur).
    const s = json.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    if (s.length <= PART_SIZE) return ws.send(s);
    // One split frame at a time: the host reassembles in arrival order.
    this.splitQueue = this.splitQueue.then(async () => {
      for (let i = 0; i < s.length; i += PART_SIZE) {
        // Let the previous piece reach the socket first, or the browser batches them into one write.
        for (let n = 0; n < 200 && ws.bufferedAmount > 0; n++) await hop();
        await hop();
        if (ws.readyState !== 1) return;
        ws.send((i + PART_SIZE >= s.length ? "~1" : "~0") + s.slice(i, i + PART_SIZE));
      }
    });
  }

  /** Fire-and-forget frame (remote-control input). */
  sendFrame(f: ClientFrame): void {
    if (this.ws?.readyState === 1) this.sendText(this.ws, JSON.stringify(f));
  }

  call<M extends MethodName>(m: M, d: MethodParams<M>, timeoutMs = 15_000): Promise<MethodResults[M]> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new RpcError("network", t("err.noConnection")));
      const id = ++this.seq;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", t("err.timeout")));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sendText(this.ws, JSON.stringify({ t: "req", id, m, d }));
    });
  }
}
