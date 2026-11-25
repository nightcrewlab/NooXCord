import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import {
  APP_VERSION, CLOSE, LIMITS, MAX_FRAME_CHARS, P, PING_INTERVAL_MS, has,
  type ClientFrame, type HostInfo, type IceServer, type MethodName,
} from "@nooxcord/shared";
import type { Client } from "@libsql/client";
import { Api } from "./api";
import { Auth } from "./auth";
import { Blobs, blobIdOf } from "./blobs";
import { Db } from "./db";
import { Hub, type Conn } from "./hub";
import { Store, mapAttachment } from "./store";
import { proxyImage, setProxyKey } from "./unfurl";
import { AppError, fail, httpStatus, newId } from "./util";
import { Voice } from "./voice";

export interface HostOptions {
  /** Local working copy of the database (with Turso: rebuilt from Turso at every start). */
  dataDir: string;
  port: number;
  /** Interface to bind; default all interfaces. */
  bind?: string;
  /** Built web client to serve at "/" (optional). */
  webDir?: string;
  name?: string;
  logger?: boolean;
  config?: Partial<HostConfig>;
  /** Turso database the local copy mirrors (ADR 0003); none = local file only. */
  remote?: Client;
  /** STUN / TURN servers for voice (ice.ts); default public STUN only. */
  iceServers?: () => Promise<IceServer[]>;
  log?: (...a: unknown[]) => void;
}

/** Host-owner settings (environment variables on the server, never over the network). */
export interface HostConfig {
  allowRegistration: boolean;
  allowGuests: boolean;
  /** Optional shared password for browser guests (the host is on the public internet). */
  guestPassword: string | null;
}

export interface RunningHost {
  port: number;
  setConfig(c: Partial<HostConfig>): void;
  close(): Promise<void>;
}

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|aac|flac))$/;

/** Detects common image formats from magic bytes; returns null when unknown. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Address of the client behind the hosting proxy. Render's edge is Cloudflare, which always overwrites
 * CF-Connecting-IP, while X-Forwarded-For starts with whatever the client sent (so its first entry,
 * which `trustProxy` reports, can be faked to dodge the rate limits).
 */
function clientIp(headers: IncomingHttpHeaders, fallback: string | undefined): string {
  const cf = headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0 && cf.length <= 45) return cf;
  return fallback || "?";
}

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const log = opts.log ?? ((...a: unknown[]) => console.log(...a));
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const dbFile = path.join(opts.dataDir, "nooxcord.db");
  const db = opts.remote ? await Db.open(dbFile, opts.remote, log) : new Db(dbFile);
  const blobs = new Blobs(db);
  // Link-preview proxy key: in the database, so signed links survive restarts on a host without a disk.
  let key = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'proxy_key'")?.value;
  if (!key || !/^[0-9a-f]{64}$/.test(key)) {
    key = randomBytes(32).toString("hex");
    db.run("INSERT INTO settings (key, value) VALUES ('proxy_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key);
  }
  setProxyKey(Buffer.from(key, "hex"));
  const hub = new Hub();
  const store = new Store(db, hub.isOnline);
  const auth = new Auth(db, store);
  const api = new Api(db, store, hub, blobs);
  const config: HostConfig = { allowRegistration: true, allowGuests: true, guestPassword: null, ...opts.config };
  const info: HostInfo = { name: opts.name ?? os.hostname(), version: APP_VERSION, allowRegistration: true, allowGuests: true, guestPassword: false, parts: true };
  const syncInfo = () => Object.assign(info, { allowRegistration: config.allowRegistration, allowGuests: config.allowGuests, guestPassword: !!config.guestPassword });
  syncInfo();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024, trustProxy: true });

  // Token auth only (no cookies), so any origin may call the API: the desktop app loads from file:// or a dev server.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    if (req.method === "OPTIONS") {
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof AppError) return reply.code(httpStatus[err.code]).send({ code: err.code, msg: err.message });
    if (err.name === "ZodError") return reply.code(400).send({ code: "bad_request", msg: "Geçersiz bilgi." });
    if (err.statusCode === 429) return reply.code(429).send({ code: "rate_limited", msg: "Çok fazla istek. Biraz bekleyin." });
    if (err.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ code: "bad_request", msg: "Dosya çok büyük." });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ code: "bad_request", msg: err.message });
    app.log.error(err);
    return reply.code(500).send({ code: "internal", msg: "Sunucu hatası." });
  });

  await app.register(rateLimit, { global: false, keyGenerator: (req) => clientIp(req.headers, req.ip) });
  await app.register(multipart, { limits: { fileSize: LIMITS.uploadMaxBytes, files: 1, fields: 4 } });

  const bearer = (req: FastifyRequest): string | undefined => {
    const h = req.headers.authorization;
    return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
  };
  const requireUser = (req: FastifyRequest): string => auth.resolve(bearer(req)) ?? fail("unauthorized", "Oturum geçersiz.");

  /** Reads the single multipart file into memory, enforcing a byte limit (files are kept in the database). */
  async function readUpload(req: FastifyRequest, maxBytes: number) {
    const part = await req.file({ limits: { fileSize: maxBytes } });
    if (!part) fail("bad_request", "Dosya yok.");
    const data = await part!.toBuffer();
    if (part!.file.truncated) fail("bad_request", "Dosya çok büyük.");
    const fields = part!.fields as Record<string, { value?: unknown } | undefined>;
    const num = (k: string) => {
      const v = Number(fields[k]?.value);
      return Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v) : null;
    };
    return { data, size: data.byteLength, name: part!.filename || "dosya", mime: part!.mimetype || "application/octet-stream", width: num("width"), height: num("height") };
  }

  // ---------- HTTP API ----------
  app.get("/api/info", async () => info);

  const authLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.post("/api/auth/register", authLimit, async (req) => {
    if (!info.allowRegistration) fail("forbidden", "Bu sunucuda kayıt kapalı.");
    return auth.register(req.body, req.headers["user-agent"]);
  });
  app.post("/api/auth/guest", authLimit, async (req) => {
    if (!config.allowGuests) fail("forbidden", "Bu sunucuda misafir girişi kapalı.");
    return auth.guest(req.body, req.headers["user-agent"], config.guestPassword);
  });
  app.post("/api/auth/login", authLimit, async (req) => auth.login(req.body, req.headers["user-agent"]));
  app.post("/api/auth/logout", async (req) => {
    const t = bearer(req);
    if (t) auth.logout(t);
    return { ok: true };
  });
  app.get("/api/me", async (req) => store.selfUser(store.userRow(requireUser(req))!));

  app.post("/api/uploads", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const uid = requireUser(req);
    const f = await readUpload(req, LIMITS.uploadMaxBytes);
    const sniffed = sniffImage(f.data);
    // Never trust a client-declared image type; never serve active content inline.
    const mime = sniffed ?? (f.mime.startsWith("image/") ? "application/octet-stream" : f.mime.slice(0, 100));
    const stored = blobs.put(f.data);
    const id = newId();
    db.run(
      "INSERT INTO attachments (id, owner_id, name, mime, size, stored, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, uid, f.name.slice(0, 200), mime, f.size, stored, sniffed ? f.width : null, sniffed ? f.height : null, Date.now(),
    );
    return mapAttachment({ id, message_id: null, name: f.name.slice(0, 200), mime, size: f.size, width: sniffed ? f.width : null, height: sniffed ? f.height : null });
  });

  /** Stores an image upload; returns "<blob id>.<ext>". */
  async function saveImage(req: FastifyRequest): Promise<string> {
    const f = await readUpload(req, LIMITS.avatarMaxBytes);
    const type = sniffImage(f.data);
    if (!type) fail("bad_request", "Yalnızca PNG, JPEG, GIF veya WebP.");
    return `${blobs.put(f.data)}.${type!.split("/")[1]}`;
  }
  const dropImage = (url: string | null | undefined) => { const id = blobIdOf(url); if (id) blobs.delete([id]); };

  app.post("/api/me/avatar", async (req) => {
    const uid = requireUser(req);
    const file = await saveImage(req);
    const old = store.userRow(uid)?.avatar;
    db.run("UPDATE users SET avatar = ? WHERE id = ?", `/avatars/${file}`, uid);
    dropImage(old);
    const row = store.userRow(uid)!;
    hub.toUsers(store.relatedUserIds(uid), "user.update", store.publicUser(row));
    return store.selfUser(row);
  });

  app.delete("/api/me/avatar", async (req) => {
    const uid = requireUser(req);
    const old = store.userRow(uid)?.avatar;
    db.run("UPDATE users SET avatar = NULL WHERE id = ?", uid);
    dropImage(old);
    const row = store.userRow(uid)!;
    hub.toUsers(store.relatedUserIds(uid), "user.update", store.publicUser(row));
    return store.selfUser(row);
  });

  app.post<{ Params: { id: string } }>("/api/guilds/:id/icon", async (req) => {
    const uid = requireUser(req);
    const g = store.guild(req.params.id);
    if (!g || !store.isMember(g.id, uid)) fail("not_found", "Sunucu bulunamadı.");
    if (!has(store.perms(g!.id, uid), P.MANAGE_GUILD)) fail("forbidden", "Bu işlem için yetkin yok.");
    const file = await saveImage(req);
    db.run("UPDATE guilds SET icon = ? WHERE id = ?", `/guild-icons/${file}`, g!.id);
    dropImage(g!.icon);
    const out = store.guild(g!.id)!;
    hub.toUsers(store.memberUserIds(g!.id), "guild.update", out);
    return out;
  });

  // ---------- files ----------
  // Attachment URLs are unguessable capability links (time id + 32 random bits + filename).
  app.get<{ Params: { id: string; name: string } }>("/files/:id/:name", async (req, reply) => {
    const a = db.get<{ stored: string; mime: string; name: string; size: number }>(
      "SELECT stored, mime, name, size FROM attachments WHERE id = ? AND message_id IS NOT NULL", req.params.id,
    );
    const body = a ? blobs.get(a.stored) : null;
    if (!a || !body) return reply.code(404).send();
    const inline = SAFE_INLINE.test(a.mime);
    reply
      .header("content-type", inline ? a.mime : "application/octet-stream")
      .header("content-length", body.byteLength)
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    return reply.send(body);
  });

  const serveImages = (prefix: string) =>
    app.get<{ Params: { file: string } }>(`${prefix}/:file`, async (req, reply: FastifyReply) => {
      const m = /^([a-z0-9]+)\.(png|jpeg|gif|webp)$/.exec(req.params.file);
      const body = m ? blobs.get(m[1]!) : null;
      if (!m || !body) return reply.code(404).send();
      return reply.header("content-type", `image/${m[2]}`).header("cache-control", "public, max-age=31536000, immutable").send(body);
    });
  serveImages("/avatars");
  serveImages("/guild-icons");

  // Link-preview images through the host (signed links only), so viewers never contact third parties.
  app.get<{ Params: { sig: string; enc: string } }>("/proxy/img/:sig/:enc", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const img = await proxyImage(req.params.sig, req.params.enc, sniffImage);
    if (!img) return reply.code(404).send();
    return reply
      .header("content-type", img.type)
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "public, max-age=86400")
      .send(img.body);
  });

  // ---------- stream thumbnails (in memory, one per streamer) ----------
  app.post("/api/stream/thumbnail", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const uid = requireUser(req);
    const part = await req.file({ limits: { fileSize: LIMITS.thumbnailMaxBytes } });
    if (!part) fail("bad_request", "Dosya yok.");
    const buf = await part!.toBuffer().catch(() => fail("bad_request", "Önizleme çok büyük."));
    if (sniffImage(buf) !== "image/jpeg") fail("bad_request", "Önizleme JPEG olmalı.");
    return { url: media.setThumbnail(uid, buf) };
  });
  app.get<{ Params: { file: string } }>("/thumbs/:file", async (req, reply) => {
    const buf = media.thumbnail(path.basename(req.params.file));
    if (!buf) return reply.code(404).send();
    return reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=3600").send(buf);
  });

  // ---------- web client ----------
  if (opts.webDir && fs.existsSync(path.join(opts.webDir, "index.html"))) {
    // wildcard: files are looked up per request, so a rebuilt client is picked up without restarting.
    await app.register(fastifyStatic, { root: opts.webDir, wildcard: true, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ code: "not_found", msg: "Bulunamadı." });
    });
  }

  // ---------- realtime ----------
  let stopping = false;
  const media = new Voice(store, hub, opts.iceServers ?? (() => [{ urls: "stun:stun.l.google.com:19302" }]), log);
  store.voiceOf = (g) => media.voiceStates(g);
  api.media = media;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  app.server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req: import("node:http").IncomingMessage) => {
    const fwd = req.headers["x-forwarded-for"];
    const ip = clientIp(req.headers, (typeof fwd === "string" ? fwd.split(",")[0]!.trim() : "") || req.socket.remoteAddress);
    let conn: Conn | null = null;
    let tokens = 40; // request budget, refilled 20/s
    const refill = setInterval(() => (tokens = Math.min(40, tokens + 20)), 1000);
    const authTimer = setTimeout(() => ws.close(CLOSE.AUTH_TIMEOUT, "auth timeout"), 8000);
    let lastSeen = Date.now();
    let parts: string[] = []; // a split client frame being reassembled (PART_SIZE)
    let partChars = 0;

    // Anything a socket sends is untrusted, signed in or not: a frame that makes the handler throw must
    // cost that frame only (an unhandled rejection here would take the whole host down).
    ws.on("message", (data) => void onFrame(data).catch((e: unknown) => console.error("[ws] frame failed:", e)));

    const onFrame = async (data: unknown): Promise<void> => {
      if (stopping) return;
      lastSeen = Date.now();
      let text = String(data);
      if (text.charCodeAt(0) === 126 /* ~ */) {
        partChars += text.length - 2;
        if (partChars > MAX_FRAME_CHARS) { parts = []; partChars = 0; return; }
        parts.push(text.slice(2));
        if (text[1] !== "1") return;
        text = parts.join("");
        parts = [];
        partChars = 0;
      }
      let f: ClientFrame;
      try { f = JSON.parse(text); } catch { return; }
      if (!f || typeof f !== "object") return; // "null", a number, a string
      if (f.t === "ping") return ws.send('{"t":"pong"}');
      if (f.t === "pong") return;
      if (f.t === "auth") {
        if (conn) return;
        const token: unknown = f.d?.token;
        const uid = typeof token === "string" ? auth.resolve(token) : null;
        if (!uid || !store.userRow(uid)) return ws.close(CLOSE.AUTH_FAILED, "auth failed");
        clearTimeout(authTimer);
        conn = { ws, userId: uid, lastSeen, desktop: f.d?.client === "desktop" };
        const cameOnline = hub.add(conn);
        console.log(`[ws] ${store.userRow(uid)!.nickname} connected (${conn.desktop ? "desktop" : "browser"}, ${ip})`);
        const guildIds = store.guildIdsOf(uid);
        hub.send(conn, {
          t: "evt", e: "ready",
          d: {
            user: store.selfUser(store.userRow(uid)!),
            users: store.usersFor(uid),
            dms: store.dmsOf(uid),
            guilds: guildIds.map((g) => store.guildState(g, uid)),
            readStates: store.readStates(uid),
            host: info,
          },
        });
        if (cameOnline) hub.toUsers(store.relatedUserIds(uid), "user.update", store.publicUser(store.userRow(uid)!), uid);
        return;
      }
      if (f.t === "rc") return void (conn && media.remoteInput(conn, f));
      if (f.t !== "req" || !conn || typeof f.m !== "string") return;
      const c = conn;
      if (tokens-- <= 0) return hub.send(c, { t: "res", id: f.id, ok: false, e: { code: "rate_limited", msg: "Çok hızlı." } });
      try {
        const d = media.isMediaMethod(f.m) ? await media.call(c, f.m as MethodName, f.d) : await api.call(c.userId, f.m as MethodName, f.d);
        hub.send(c, { t: "res", id: f.id, ok: true, d });
      } catch (e) {
        if (e instanceof AppError) hub.send(c, { t: "res", id: f.id, ok: false, e: { code: e.code, msg: e.message } });
        else {
          app.log.error(e);
          console.error(`[rpc] ${f.m} failed:`, e); // lands in the host log
          hub.send(c, { t: "res", id: f.id, ok: false, e: { code: "internal", msg: "Sunucu hatası." } });
        }
      }
    };

    const ping = setInterval(() => {
      if (Date.now() - lastSeen > 15_000) {
        if (conn) console.log(`[ws] ${store.userRow(conn.userId)?.nickname ?? conn.userId}: nothing received for 15 s, dropping (network path stalled)`);
        return ws.terminate();
      }
      if (ws.readyState === 1) ws.send('{"t":"ping"}');
    }, PING_INTERVAL_MS);

    ws.on("close", (code: number) => {
      clearInterval(refill);
      clearInterval(ping);
      clearTimeout(authTimer);
      if (stopping) return; // DB may already be closed
      if (conn) console.log(`[ws] ${store.userRow(conn.userId)?.nickname ?? conn.userId} disconnected (${code})`);
      if (conn) media.connClosed(conn);
      if (conn && hub.remove(conn)) {
        const row = store.userRow(conn.userId);
        if (row) hub.toUsers(store.relatedUserIds(conn.userId), "user.update", store.publicUser(row), conn.userId);
      }
    });
  });

  // ---------- housekeeping ----------
  const sweep = setInterval(() => {
    const old = db.all<{ id: string; stored: string }>("SELECT id, stored FROM attachments WHERE message_id IS NULL AND created_at < ?", Date.now() - 3600_000);
    for (const a of old) db.run("DELETE FROM attachments WHERE id = ?", a.id);
    blobs.delete(old.map((a) => a.stored));
    db.run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    auth.sweep();
    api.sweep();
  }, 30 * 60_000);

  await app.listen({ port: opts.port, host: opts.bind ?? "0.0.0.0" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port,
    setConfig(c) {
      Object.assign(config, c);
      syncInfo();
      for (const conn of hub.all()) hub.send(conn, { t: "evt", e: "host.update", d: info });
    },
    async close() {
      stopping = true;
      clearInterval(sweep);
      await media.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await app.close();
      if (!(await db.flush(10_000))) console.error(`[db] ${db.pendingMirror} writes did not reach Turso before shutdown`);
      db.close();
    },
  };
}
