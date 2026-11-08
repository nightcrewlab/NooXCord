import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import {
  APP_VERSION, CLOSE, LIMITS, P, PING_INTERVAL_MS, has,
  type ClientFrame, type HostInfo, type MethodName,
} from "@nooxcord/shared";
import { Api } from "./api";
import { Auth } from "./auth";
import { Db, SCHEMA_VERSION, fileVersion } from "./db";
import { dailyBackup, prune, snapshot, type BackupInfo } from "./backup";
import { Hub, type Conn } from "./hub";
import { Media } from "./media";
import { Store, mapAttachment } from "./store";
import { proxyImage, setProxyKey } from "./unfurl";
import { AppError, fail, httpStatus, newId } from "./util";

export interface HostOptions {
  dataDir: string;
  port: number;
  /** Interface to bind; default all interfaces. */
  bind?: string;
  /** Built web client to serve at "/" (optional). */
  webDir?: string;
  name?: string;
  logger?: boolean;
  config?: Partial<HostConfig>;
}

/** Host-owner settings (set by the desktop app, never over the network). */
export interface HostConfig {
  allowRegistration: boolean;
  allowGuests: boolean;
  /** Optional shared password for browser guests (recommended when a tunnel is open). */
  guestPassword: string | null;
  /** The owner's open tunnel (shown to signed-in members as "switch to tunnel"), null when closed. */
  tunnelUrl: string | null;
}

export interface RunningHost {
  port: number;
  setConfig(c: Partial<HostConfig>): void;
  /** Snapshot of the database into dataDir/backups (keeps the newest 7). */
  backup(tag?: string): BackupInfo;
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

function readHead(file: string, n = 16): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(n);
    const read = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const dirs = {
    uploads: path.join(opts.dataDir, "uploads"),
    avatars: path.join(opts.dataDir, "avatars"),
    icons: path.join(opts.dataDir, "guild-icons"),
  };
  for (const d of [opts.dataDir, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });

  const dbFile = path.join(opts.dataDir, "nooxcord.db");
  const backupsDir = path.join(opts.dataDir, "backups");
  // Keep a copy of the old schema before migrating (e.g. the Faz 4 channels rebuild).
  if (fs.existsSync(dbFile)) {
    const v = fileVersion(dbFile);
    if (v > 0 && v < SCHEMA_VERSION) snapshot(dbFile, backupsDir, `v${v}`);
  }
  const db = new Db(dbFile);
  const backupTimer = setInterval(() => { try { dailyBackup(db.raw, backupsDir); } catch (e) { console.error("[backup]", e); } }, 6 * 60 * 60_000);
  try { dailyBackup(db.raw, backupsDir); } catch (e) { console.error("[backup]", e); }
  const keyFile = path.join(opts.dataDir, "proxy.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32));
  setProxyKey(fs.readFileSync(keyFile));
  const hub = new Hub();
  const store = new Store(db, hub.isOnline);
  const auth = new Auth(db, store);
  const api = new Api(db, store, hub, dirs.uploads);
  const config: HostConfig = { allowRegistration: true, allowGuests: true, guestPassword: null, tunnelUrl: null, ...opts.config };
  const info: HostInfo = { name: opts.name ?? os.hostname(), version: APP_VERSION, allowRegistration: true, allowGuests: true, guestPassword: false, tunnelUrl: null };
  const syncInfo = () => Object.assign(info, { allowRegistration: config.allowRegistration, allowGuests: config.allowGuests, guestPassword: !!config.guestPassword, tunnelUrl: config.tunnelUrl });
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

  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: LIMITS.uploadMaxBytes, files: 1, fields: 4 } });

  const bearer = (req: FastifyRequest): string | undefined => {
    const h = req.headers.authorization;
    return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
  };
  const requireUser = (req: FastifyRequest): string => auth.resolve(bearer(req)) ?? fail("unauthorized", "Oturum geçersiz.");

  /** Saves the single multipart file to dir/name, enforcing a byte limit. */
  async function saveUpload(req: FastifyRequest, dir: string, maxBytes: number) {
    const part = await req.file({ limits: { fileSize: maxBytes } });
    if (!part) fail("bad_request", "Dosya yok.");
    const stored = newId();
    const dest = path.join(dir, stored);
    await pipeline(part!.file, fs.createWriteStream(dest));
    if (part!.file.truncated) {
      fs.rmSync(dest, { force: true });
      fail("bad_request", "Dosya çok büyük.");
    }
    const size = fs.statSync(dest).size;
    const fields = part!.fields as Record<string, { value?: unknown } | undefined>;
    const num = (k: string) => {
      const v = Number(fields[k]?.value);
      return Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v) : null;
    };
    return { stored, dest, size, name: part!.filename || "dosya", mime: part!.mimetype || "application/octet-stream", width: num("width"), height: num("height") };
  }

  // ---------- HTTP API ----------
  // The tunnel URL is for members only (ready / host.update), not for anyone probing the port.
  app.get("/api/info", async () => ({ ...info, tunnelUrl: null }));

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
    const f = await saveUpload(req, dirs.uploads, LIMITS.uploadMaxBytes);
    const sniffed = sniffImage(readHead(f.dest));
    // Never trust a client-declared image type; never serve active content inline.
    const mime = sniffed ?? (f.mime.startsWith("image/") ? "application/octet-stream" : f.mime.slice(0, 100));
    const id = newId();
    db.run(
      "INSERT INTO attachments (id, owner_id, name, mime, size, stored, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, uid, f.name.slice(0, 200), mime, f.size, f.stored, sniffed ? f.width : null, sniffed ? f.height : null, Date.now(),
    );
    return mapAttachment({ id, message_id: null, name: f.name.slice(0, 200), mime, size: f.size, width: sniffed ? f.width : null, height: sniffed ? f.height : null });
  });

  async function saveImage(req: FastifyRequest, dir: string): Promise<string> {
    const f = await saveUpload(req, dir, LIMITS.avatarMaxBytes);
    const type = sniffImage(readHead(f.dest));
    if (!type) {
      fs.rmSync(f.dest, { force: true });
      fail("bad_request", "Yalnızca PNG, JPEG, GIF veya WebP.");
    }
    const file = `${f.stored}.${type!.split("/")[1]}`;
    fs.renameSync(f.dest, path.join(dir, file));
    return file;
  }

  app.post("/api/me/avatar", async (req) => {
    const uid = requireUser(req);
    const file = await saveImage(req, dirs.avatars);
    const old = store.userRow(uid)?.avatar;
    db.run("UPDATE users SET avatar = ? WHERE id = ?", `/avatars/${file}`, uid);
    if (old) fs.rm(path.join(dirs.avatars, path.basename(old)), { force: true }, () => {});
    const row = store.userRow(uid)!;
    hub.toUsers(store.relatedUserIds(uid), "user.update", store.publicUser(row));
    return store.selfUser(row);
  });

  app.delete("/api/me/avatar", async (req) => {
    const uid = requireUser(req);
    const old = store.userRow(uid)?.avatar;
    db.run("UPDATE users SET avatar = NULL WHERE id = ?", uid);
    if (old) fs.rm(path.join(dirs.avatars, path.basename(old)), { force: true }, () => {});
    const row = store.userRow(uid)!;
    hub.toUsers(store.relatedUserIds(uid), "user.update", store.publicUser(row));
    return store.selfUser(row);
  });

  app.post<{ Params: { id: string } }>("/api/guilds/:id/icon", async (req) => {
    const uid = requireUser(req);
    const g = store.guild(req.params.id);
    if (!g || !store.isMember(g.id, uid)) fail("not_found", "Sunucu bulunamadı.");
    if (!has(store.perms(g!.id, uid), P.MANAGE_GUILD)) fail("forbidden", "Bu işlem için yetkin yok.");
    const file = await saveImage(req, dirs.icons);
    db.run("UPDATE guilds SET icon = ? WHERE id = ?", `/guild-icons/${file}`, g!.id);
    if (g!.icon) fs.rm(path.join(dirs.icons, path.basename(g!.icon)), { force: true }, () => {});
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
    if (!a) return reply.code(404).send();
    const inline = SAFE_INLINE.test(a.mime);
    reply
      .header("content-type", inline ? a.mime : "application/octet-stream")
      .header("content-length", a.size)
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    return reply.send(fs.createReadStream(path.join(dirs.uploads, a.stored)));
  });

  const serveImageDir = (prefix: string, dir: string) =>
    app.get<{ Params: { file: string } }>(`${prefix}/:file`, async (req, reply: FastifyReply) => {
      const file = path.basename(req.params.file);
      const full = path.join(dir, file);
      if (!/^[a-z0-9]+\.(png|jpeg|gif|webp)$/.test(file) || !fs.existsSync(full)) return reply.code(404).send();
      reply.header("content-type", `image/${file.split(".")[1]}`).header("cache-control", "public, max-age=31536000, immutable");
      return reply.send(fs.createReadStream(full));
    });
  serveImageDir("/avatars", dirs.avatars);
  serveImageDir("/guild-icons", dirs.icons);

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
    if (!media) fail("internal", "Ses sunucusu hazır değil.");
    return { url: media!.setThumbnail(uid, buf) };
  });
  app.get<{ Params: { file: string } }>("/thumbs/:file", async (req, reply) => {
    const buf = media?.thumbnail(path.basename(req.params.file));
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
  let media: Media | null = null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  // Tunnel-mode media (NXM-WS): binary frames, authenticated by a one-time ticket from voice.join.
  // Up to one H.264 access unit per message: screen key frames reach a few hundred KB (MAX_VIDEO_FRAME in wsMedia.ts).
  const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  app.server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/media") return mediaWss.handleUpgrade(req, socket, head, (ws) => media?.attachSocket(ws));
    if (pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req: import("node:http").IncomingMessage) => {
    const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
    let conn: Conn | null = null;
    let tokens = 40; // request budget, refilled 20/s
    const refill = setInterval(() => (tokens = Math.min(40, tokens + 20)), 1000);
    const authTimer = setTimeout(() => ws.close(CLOSE.AUTH_TIMEOUT, "auth timeout"), 8000);
    let lastSeen = Date.now();

    ws.on("message", async (data) => {
      if (stopping) return;
      lastSeen = Date.now();
      let f: ClientFrame;
      try { f = JSON.parse(String(data)); } catch { return; }
      if (f.t === "ping") return ws.send('{"t":"pong"}');
      if (f.t === "pong") return;
      if (f.t === "auth") {
        if (conn) return;
        const uid = auth.resolve(f.d?.token);
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
      if (f.t === "rc") return void (conn && media?.remoteInput(conn, f));
      if (f.t !== "req" || !conn) return;
      if (tokens-- <= 0) return hub.send(conn, { t: "res", id: f.id, ok: false, e: { code: "rate_limited", msg: "Çok hızlı." } });
      try {
        const d = media && media.isMediaMethod(f.m) ? await media.call(conn, f.m as MethodName, f.d) : await api.call(conn.userId, f.m as MethodName, f.d);
        hub.send(conn, { t: "res", id: f.id, ok: true, d });
      } catch (e) {
        if (e instanceof AppError) hub.send(conn, { t: "res", id: f.id, ok: false, e: { code: e.code, msg: e.message } });
        else {
          app.log.error(e);
          hub.send(conn, { t: "res", id: f.id, ok: false, e: { code: "internal", msg: "Sunucu hatası." } });
        }
      }
    });

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
      if (conn) media?.connClosed(conn);
      if (conn && hub.remove(conn)) {
        const row = store.userRow(conn.userId);
        if (row) hub.toUsers(store.relatedUserIds(conn.userId), "user.update", store.publicUser(row), conn.userId);
      }
    });
  });

  // ---------- housekeeping ----------
  const sweep = setInterval(() => {
    const old = db.all<{ id: string; stored: string }>("SELECT id, stored FROM attachments WHERE message_id IS NULL AND created_at < ?", Date.now() - 3600_000);
    for (const a of old) {
      db.run("DELETE FROM attachments WHERE id = ?", a.id);
      fs.rm(path.join(dirs.uploads, a.stored), { force: true }, () => {});
    }
    db.run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
  }, 30 * 60_000);

  await app.listen({ port: opts.port, host: opts.bind ?? "0.0.0.0" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  // Media (WebRTC) uses the next port, UDP + TCP. The worker starts on the first voice join.
  media = new Media(store, hub, port + 1, opts.bind, (...a) => console.log(...a));
  store.voiceOf = (g) => media!.voiceStates(g);
  api.media = media;

  return {
    port,
    setConfig(c) {
      const tunnelBefore = info.tunnelUrl;
      Object.assign(config, c);
      syncInfo();
      if (info.tunnelUrl !== tunnelBefore) {
        console.log(`[host] tunnel ${info.tunnelUrl ? `open: ${info.tunnelUrl}` : "closed"}`);
        for (const conn of hub.all()) hub.send(conn, { t: "evt", e: "host.update", d: info });
      }
    },
    backup(tag) {
      const b = snapshot(db.raw, backupsDir, tag);
      prune(backupsDir);
      return b;
    },
    async close() {
      stopping = true;
      clearInterval(backupTimer);
      clearInterval(sweep);
      await media?.close();
      for (const ws of [...wss.clients, ...mediaWss.clients]) ws.terminate();
      mediaWss.close();
      wss.close();
      await app.close();
      db.close();
    },
  };
}
