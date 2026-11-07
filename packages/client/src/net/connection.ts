import {
  CLOSE, PING_INTERVAL_MS,
  type AuthResponse, type EventName, type Events, type HostInfo, type MethodName, type MethodParams, type MethodResults,
  type SelfUser, type ServerFrame, type Attachment,
} from "@nooxcord/shared";

export class RpcError extends Error {
  constructor(readonly code: string, msg: string) {
    super(msg);
  }
}

export type ConnStatus = "connecting" | "ready" | "reconnecting" | "auth_failed" | "closed";

type Listener = <E extends EventName>(e: E, d: Events[E]) => void;

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
      throw new RpcError("network", "Sunucuya ulaşılamadı.");
    }
    const data = (await res.json().catch(() => ({}))) as { code?: string; msg?: string };
    if (!res.ok) throw new RpcError(data.code ?? "internal", data.msg ?? "Sunucu hatası.");
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
        else reject(new RpcError(data.code ?? "internal", data.msg ?? "Yükleme başarısız."));
      };
      xhr.onerror = () => reject(new RpcError("network", "Yükleme başarısız."));
      xhr.onabort = () => reject(new RpcError("aborted", "İptal edildi."));
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
      ws.send(JSON.stringify({ t: "auth", d: { token: this.http.token } }));
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (Date.now() - this.lastRecv > 12_000) return ws.close(4000, "stale");
        if (ws.readyState === 1) ws.send('{"t":"ping"}');
      }, PING_INTERVAL_MS);
    };
    ws.onmessage = (ev) => {
      this.lastRecv = Date.now();
      let f: ServerFrame;
      try { f = JSON.parse(ev.data as string); } catch { return; }
      if (f.t === "ping") return ws.send('{"t":"pong"}');
      if (f.t === "pong") return;
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
          this.setStatus("ready");
        }
        for (const fn of this.listeners) fn(f.e, f.d as never);
      }
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError("network", "Bağlantı koptu."));
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

  call<M extends MethodName>(m: M, d: MethodParams<M>, timeoutMs = 15_000): Promise<MethodResults[M]> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new RpcError("network", "Bağlantı yok."));
      const id = ++this.seq;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", "Sunucu yanıt vermedi."));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ t: "req", id, m, d }));
    });
  }
}
