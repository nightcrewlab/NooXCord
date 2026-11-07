import os from "node:os";
import * as mediasoup from "mediasoup";
import type { WebSocket } from "ws";
import type { types as ms } from "mediasoup";
import {
  LIMITS, P, has,
  type ConsumerParams, type EventName, type Events, type MediaMethodName, type MediaSource, type MethodName, type MethodResults,
  type RemoteProducer, type TransportParams, type VoiceJoinResult, type VoiceState,
} from "@nooxcord/shared";
import { Methods, RemoteInput } from "@nooxcord/shared/schemas";
import type { Conn, Hub } from "./hub";
import type { Store } from "./store";
import { FRAME_MIC, FrameAssembler, audioFrame, buildRtp, parseRtp, videoFrame } from "./rtp";
import { fail, randomToken } from "./util";

/*
 * Voice & streaming SFU (mediasoup). One router per active voice channel, one WebRtcServer
 * (single UDP+TCP port = main port + 1) shared by every transport. A user has at most one voice
 * session, bound to the socket that joined; when that socket closes the session ends.
 */

const CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  // H.264 first: hardware encoders on Windows and the WebSocket fallback path (Faz 3) both want it.
  { kind: "video", mimeType: "video/H264", clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 } },
  { kind: "video", mimeType: "video/H264", clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "4d0032", "level-asymmetry-allowed": 1 } },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
];

interface ProducerEntry { producer: ms.Producer; source: MediaSource }

/** Tunnel-mode (NXM-WS) state of a peer: media goes over a WebSocket instead of WebRTC. */
interface WsLink {
  ticket: string;
  sock: WebSocket | null;
  nextTag: number;
  micSsrc: number;
  micSeq: number;
  micTs: number;
  sent: number;
}

const MIC_PT = 100;
const VIDEO_BACKLOG = 1_500_000; // bytes queued on the socket before we skip to the next key frame
const AUDIO_BACKLOG = 4_000_000;

interface Peer {
  userId: string;
  conn: Conn;
  room: Room;
  state: VoiceState;
  send: ms.WebRtcTransport | ms.DirectTransport;
  recv: ms.WebRtcTransport | ms.DirectTransport;
  ws: WsLink | null;
  producers: Map<string, ProducerEntry>;
  consumers: Map<string, ms.Consumer>;
  /** Streamers this peer is watching. */
  watching: Set<string>;
}

interface Room {
  channelId: string;
  guildId: string;
  router: ms.Router;
  peers: Map<string, Peer>;
  speaking: string[];
}

interface Thumb { id: string; buf: Buffer }

type Params<M extends MethodName> = ReturnType<(typeof Methods)[M]["parse"]>;

/** IPv4 addresses the media server listens on: every LAN/Hamachi/VPN interface plus loopback. */
function listenIps(bind?: string): string[] {
  if (bind && bind !== "0.0.0.0" && bind !== "::") return [bind];
  const ips = new Set<string>(["127.0.0.1"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) ips.add(a.address);
  }
  return [...ips];
}

export class Media {
  private worker: ms.Worker | null = null;
  private webRtcServer: ms.WebRtcServer | null = null;
  private starting: Promise<void> | null = null;
  private rooms = new Map<string, Room>();
  private peers = new Map<string, Peer>();
  private thumbs = new Map<string, Thumb>(); // userId -> latest stream thumbnail
  private tickets = new Map<string, Peer>();
  private closed = false;
  /** Remote control: last input per streamer, last request per viewer>streamer pair, input rate per viewer. */
  private rcLastInput = new Map<string, number>();
  private rcLastRequest = new Map<string, number>();
  private rcRate = new Map<string, { at: number; n: number }>();
  private rcTimer = setInterval(() => this.rcSweep(), 30_000);

  constructor(private store: Store, private hub: Hub, private port: number, private bind?: string, private log: (...a: unknown[]) => void = () => {}) {}

  // ---------- public API used by the host ----------

  isMediaMethod(m: string): boolean {
    return m.startsWith("voice.") || m.startsWith("media.") || m.startsWith("stream.") || m.startsWith("remote.");
  }

  async call<M extends MethodName>(conn: Conn, method: M, raw: unknown): Promise<MethodResults[M]> {
    const schema = Methods[method];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail("bad_request", parsed.error.issues[0]?.message ?? "Geçersiz istek.");
    const h = (this.handlers as Record<string, (c: Conn, p: never) => unknown>)[method];
    if (!h) fail("bad_request", "Bilinmeyen işlem.");
    return (await h!(conn, parsed.data as never)) as MethodResults[M];
  }

  /** Voice states of a guild, for GuildState. */
  voiceStates(guildId: string): VoiceState[] {
    const out: VoiceState[] = [];
    for (const r of this.rooms.values()) if (r.guildId === guildId) for (const p of r.peers.values()) out.push(p.state);
    return out;
  }

  /** The socket closed: end that socket's voice session. */
  connClosed(conn: Conn): void {
    const peer = this.peers.get(conn.userId);
    if (peer && peer.conn === conn) this.leave(peer);
  }

  /** Remove a user from voice in a guild (kick, ban, leave). */
  evict(guildId: string, userId: string): void {
    const peer = this.peers.get(userId);
    if (peer && peer.room.guildId === guildId) this.leave(peer, "removed");
  }

  /** Channel or guild deleted. */
  closeWhere(pred: (room: { channelId: string; guildId: string }) => boolean): void {
    for (const r of [...this.rooms.values()]) if (pred(r)) for (const p of [...r.peers.values()]) this.leave(p, "removed");
  }

  /** Re-check voice permissions after a role change. */
  refreshPerms(guildId: string): void {
    for (const r of this.rooms.values()) {
      if (r.guildId !== guildId) continue;
      for (const p of [...r.peers.values()]) {
        const perms = this.store.perms(guildId, p.userId);
        if (!has(perms, P.VIEW_CHANNELS) || !has(perms, P.CONNECT_VOICE)) { this.leave(p, "removed"); continue; }
        const suppressed = !has(perms, P.SPEAK);
        if (suppressed !== p.state.suppressed) {
          p.state = { ...p.state, suppressed };
          if (suppressed) this.closeSource(p, "mic");
          this.broadcastState(p);
        }
        if (!has(perms, P.STREAM) && p.state.stream) this.stopStream(p);
        if (!has(perms, P.REQUEST_REMOTE_CONTROL)) {
          for (const s of r.peers.values()) if (s.state.stream?.controllerId === p.userId) this.setController(s, null, "permission");
        }
      }
    }
  }

  /** Remote-control input frame ({t:"rc"}): forwarded to the streamer only from their current controller. */
  remoteInput(conn: Conn, frame: unknown): void {
    const parsed = RemoteInput.safeParse(frame);
    if (!parsed.success) return;
    const peer = this.peers.get(conn.userId);
    if (!peer || peer.conn !== conn) return;
    const streamer = peer.room.peers.get(parsed.data.to);
    if (!streamer || streamer.state.stream?.controllerId !== peer.userId) return;
    const now = Date.now();
    const r = this.rcRate.get(peer.userId);
    if (!r || now - r.at >= 1000) this.rcRate.set(peer.userId, { at: now, n: 1 });
    else if (++r.n > 120) return; // 120 batches/s covers 60 Hz pointer + keys
    this.rcLastInput.set(streamer.userId, now);
    this.toConn(streamer.conn, "remote.input", { from: peer.userId, ev: parsed.data.ev });
  }

  /** A /media WebSocket connected: the first message must be {"ticket": "..."} from voice.join. */
  attachSocket(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(4001, "ticket timeout"), 8000);
    let peer: Peer | null = null;
    const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 15_000); // tunnels drop idle sockets
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!peer) {
        if (isBinary) return ws.close(4001, "no ticket");
        let ticket = "";
        try { ticket = String(JSON.parse(String(data)).ticket ?? ""); } catch { /* bad frame */ }
        const p = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        if (!p || !p.ws || this.peers.get(p.userId) !== p) return ws.close(4001, "bad ticket");
        clearTimeout(timer);
        p.ws.sock?.close(4002, "replaced");
        p.ws.sock = ws;
        peer = p;
        ws.send(JSON.stringify({ ok: true }));
        return;
      }
      if (isBinary && data.length > 1 && data[0] === FRAME_MIC) this.micFrame(peer, data.subarray(1));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      clearInterval(ping);
      if (peer?.ws?.sock === ws) peer.ws.sock = null;
    });
  }

  private micFrame(p: Peer, opus: Buffer): void {
    const link = p.ws!;
    const e = [...p.producers.values()].find((x) => x.source === "mic");
    if (!e || e.producer.paused) return;
    link.micSeq = (link.micSeq + 1) & 0xffff;
    link.micTs = (link.micTs + 960) >>> 0; // 20 ms at 48 kHz
    try {
      e.producer.send(buildRtp(MIC_PT, link.micSeq, link.micTs, link.micSsrc, opus));
    } catch { /* producer closing */ }
  }

  /** Sends a frame to a tunnel-mode peer; false when the socket is too far behind. */
  private wsSend(p: Peer, buf: Buffer, limit: number): boolean {
    const sock = p.ws?.sock;
    if (!sock || sock.readyState !== 1) return false;
    if (sock.bufferedAmount > limit) return false;
    sock.send(buf);
    p.ws!.sent += buf.length;
    return true;
  }

  /** Stores the stream preview JPEG; returns its URL. */
  setThumbnail(userId: string, buf: Buffer): string {
    const id = randomToken(12);
    this.thumbs.set(userId, { id, buf });
    const url = `/thumbs/${id}.jpg`;
    const peer = this.peers.get(userId);
    if (peer?.state.stream) {
      peer.state = { ...peer.state, stream: { ...peer.state.stream, thumbnail: url } };
      this.broadcastState(peer);
    }
    return url;
  }

  thumbnail(file: string): Buffer | null {
    const id = file.replace(/\.jpg$/, "");
    for (const t of this.thumbs.values()) if (t.id === id) return t.buf;
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.rcTimer);
    for (const p of [...this.peers.values()]) this.leave(p, "error", true);
    this.worker?.close();
    this.worker = null;
  }

  // ---------- internals ----------

  private async ensureWorker(): Promise<void> {
    if (this.webRtcServer) return;
    this.starting ??= (async () => {
      const worker = await mediasoup.createWorker({ logLevel: "warn", rtcMinPort: 0, rtcMaxPort: 0 });
      worker.on("died", (err) => {
        this.log("[media] worker died", err);
        this.worker = null;
        this.webRtcServer = null;
        for (const p of [...this.peers.values()]) this.leave(p, "error", true);
      });
      const ips = listenIps(this.bind);
      try {
        this.webRtcServer = await worker.createWebRtcServer({
          listenInfos: ips.flatMap((ip) => [
            { protocol: "udp" as const, ip, port: this.port },
            { protocol: "tcp" as const, ip, port: this.port },
          ]),
        });
      } catch (e) {
        worker.close();
        throw e;
      }
      this.worker = worker;
      this.log(`[media] mediasoup ${mediasoup.version} on ${ips.join(", ")} :${this.port}`);
    })().finally(() => (this.starting = null));
    try {
      await this.starting;
    } catch (e) {
      this.log("[media] start failed", e);
      fail("internal", `Ses sunucusu başlatılamadı (port ${this.port} kullanımda olabilir).`);
    }
  }

  private async room(channelId: string, guildId: string): Promise<Room> {
    const existing = this.rooms.get(channelId);
    if (existing) return existing;
    await this.ensureWorker();
    const again = this.rooms.get(channelId); // another join may have won the race
    if (again) return again;
    const router = await this.worker!.createRouter({ mediaCodecs: CODECS });
    const room: Room = { channelId, guildId, router, peers: new Map(), speaking: [] };
    this.rooms.set(channelId, room);
    return room;
  }

  private async transport(router: ms.Router, sending: boolean): Promise<ms.WebRtcTransport> {
    const t = await router.createWebRtcTransport({
      webRtcServer: this.webRtcServer!,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: true, // remote-control data channel (Faz 4)
      initialAvailableOutgoingBitrate: 1_000_000,
    });
    if (sending) await t.setMaxIncomingBitrate(25_000_000).catch(() => {});
    return t;
  }

  private params(t: ms.WebRtcTransport): TransportParams {
    return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters, sctpParameters: t.sctpParameters };
  }

  private peerOf(conn: Conn): Peer {
    const p = this.peers.get(conn.userId);
    if (!p || p.conn !== conn) fail("bad_request", "Sesli kanalda değilsin.");
    return p!;
  }

  private toGuild<E extends EventName>(guildId: string, e: E, d: Events[E]): void {
    this.hub.toUsers(this.store.memberUserIds(guildId), e, d);
  }

  private toConn<E extends EventName>(conn: Conn, e: E, d: Events[E]): void {
    this.hub.send(conn, { t: "evt", e, d });
  }

  private broadcastState(p: Peer): void {
    this.toGuild(p.room.guildId, "voice.state", p.state);
  }

  private remote(p: Peer, e: ProducerEntry): RemoteProducer {
    return { id: e.producer.id, userId: p.userId, source: e.source, kind: e.producer.kind, paused: e.producer.paused };
  }

  /*
   * Speaking indicator: each client reports its own voice-activity gate (the same gate that decides
   * whether its microphone sends sound). Server-side RTP audio levels averaged silence into speech
   * and missed short phrases (Faz 2 test), so the gate is the single source of truth.
   */
  private setSpeaking(p: Peer, speaking: boolean): void {
    const room = p.room;
    const on = speaking && !p.state.muted && !p.state.deafened && !p.state.suppressed;
    const ids = new Set(room.speaking);
    if (on) ids.add(p.userId);
    else ids.delete(p.userId);
    const next = [...ids].filter((id) => room.peers.has(id)).sort();
    if (next.join() === room.speaking.join()) return;
    room.speaking = next;
    this.toGuild(room.guildId, "voice.speaking", { channelId: room.channelId, userIds: next });
  }

  private closeSource(p: Peer, source: MediaSource): void {
    for (const [id, e] of p.producers) if (e.source === source) { e.producer.close(); this.producerGone(p, id); }
  }

  private producerGone(p: Peer, producerId: string): void {
    p.producers.delete(producerId);
    for (const other of p.room.peers.values()) if (other !== p) this.toConn(other.conn, "media.producerClosed", { producerId });
  }

  /** May this peer control or be controlled? Never guests, never browser clients (CLAUDE.md 7.3). */
  private rcEligible(p: Peer): boolean {
    return p.conn.desktop && this.store.userRow(p.userId)?.guest !== 1;
  }

  private name(userId: string): string {
    return this.store.userRow(userId)?.nickname ?? userId;
  }

  private setController(streamer: Peer, controllerId: string | null, why: string): void {
    const s = streamer.state.stream;
    if (!s || s.controllerId === controllerId) return;
    if (s.controllerId) this.log(`[remote] ${this.name(s.controllerId)} stopped controlling ${this.name(streamer.userId)} (${why})`);
    if (controllerId) {
      this.log(`[remote] ${this.name(controllerId)} controls ${this.name(streamer.userId)}`);
      this.rcLastInput.set(streamer.userId, Date.now());
    } else this.rcLastInput.delete(streamer.userId);
    streamer.state = { ...streamer.state, stream: { ...s, controllerId } };
    this.broadcastState(streamer);
  }

  /** Ends control sessions idle for longer than LIMITS.remoteIdleMs. */
  private rcSweep(): void {
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (p.state.stream?.controllerId && now - (this.rcLastInput.get(p.userId) ?? 0) > LIMITS.remoteIdleMs) this.setController(p, null, "idle");
    }
    for (const [k, at] of this.rcLastRequest) if (now - at > 60_000) this.rcLastRequest.delete(k);
    for (const [k, r] of this.rcRate) if (now - r.at > 60_000) this.rcRate.delete(k);
  }

  private stopStream(p: Peer): void {
    this.closeSource(p, "screen");
    this.closeSource(p, "screen-audio");
    this.thumbs.delete(p.userId);
    if (!p.state.stream) return;
    if (p.state.stream.controllerId) this.log(`[remote] control of ${this.name(p.userId)} ended (stream stopped)`);
    this.rcLastInput.delete(p.userId);
    p.state = { ...p.state, stream: null };
    for (const other of p.room.peers.values()) other.watching.delete(p.userId);
    this.broadcastState(p);
  }

  private leave(p: Peer, reason?: Events["voice.ended"]["reason"], silent = false): void {
    if (this.peers.get(p.userId) === p) this.peers.delete(p.userId);
    const room = p.room;
    room.peers.delete(p.userId);
    this.thumbs.delete(p.userId);
    p.send.close(); // closes producers; consumers elsewhere get "producerclose"
    p.recv.close();
    if (p.ws) {
      this.tickets.delete(p.ws.ticket);
      p.ws.sock?.close(1000, "left");
      p.ws.sock = null;
    }
    if (reason && !silent) this.toConn(p.conn, "voice.ended", { reason });
    if (room.speaking.includes(p.userId)) {
      room.speaking = room.speaking.filter((id) => id !== p.userId);
      if (!silent && room.peers.size > 0) this.toGuild(room.guildId, "voice.speaking", { channelId: room.channelId, userIds: room.speaking });
    }
    // Stop counting this peer as a viewer.
    for (const streamer of p.watching) {
      const s = room.peers.get(streamer);
      if (s?.state.stream) {
        const was = s.state.stream.controllerId;
        const controllerId = was === p.userId ? null : was;
        if (controllerId !== was) this.log(`[remote] ${this.name(p.userId)} stopped controlling ${this.name(s.userId)} (left)`);
        s.state = { ...s.state, stream: { ...s.state.stream, viewers: s.state.stream.viewers.filter((v) => v !== p.userId), controllerId } };
        if (!silent) this.broadcastState(s);
      }
    }
    if (!silent && !this.closed) this.toGuild(room.guildId, "voice.leave", { guildId: room.guildId, channelId: room.channelId, userId: p.userId });
    if (room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(room.channelId);
    }
  }

  /** Codecs a WebCodecs client can decode from our frames: Opus, H.264, VP8; no RTX, no extensions. */
  private directCaps(router: ms.Router): ms.RtpCapabilities {
    const codecs = (router.rtpCapabilities.codecs ?? []).filter((c) => !/rtx$/i.test(c.mimeType));
    return { codecs, headerExtensions: [] };
  }

  /** Forwards a DirectTransport consumer to the peer's /media socket as whole frames. */
  private pipeToSocket(peer: Peer, consumer: ms.Consumer): number {
    const link = peer.ws!;
    const tag = link.nextTag++ & 0xffff;
    const mime = consumer.rtpParameters.codecs[0]?.mimeType.toLowerCase() ?? "";
    if (consumer.kind === "audio") {
      consumer.on("rtp", (b: Buffer) => {
        const r = parseRtp(b);
        if (r && r.payload.length > 0) this.wsSend(peer, audioFrame(tag, r.timestamp, r.payload), AUDIO_BACKLOG);
      });
      return tag;
    }
    const vp8 = mime === "video/vp8";
    let lastKeyReq = 0;
    const needKey = () => {
      const now = Date.now();
      if (now - lastKeyReq < 1000) return;
      lastKeyReq = now;
      consumer.requestKeyFrame().catch(() => {});
    };
    const asm = new FrameAssembler(vp8 ? "vp8" : "h264", (f) => {
      if (!this.wsSend(peer, videoFrame(tag, f, vp8), VIDEO_BACKLOG)) {
        asm.skipToKey();
        needKey();
      }
    }, needKey);
    consumer.on("rtp", (b: Buffer) => {
      const r = parseRtp(b);
      if (r) asm.push(r);
    });
    // Tunnels are slow: start on the small simulcast layer.
    if (consumer.type === "simulcast") consumer.setPreferredLayers({ spatialLayer: 0 }).catch(() => {});
    return tag;
  }

  // ---------- RPC handlers ----------

  private handlers: { [M in MediaMethodName]: (conn: Conn, p: Params<M>) => unknown } = {
    "voice.join": async (conn, p): Promise<VoiceJoinResult> => {
      const ch = this.store.channel(p.channelId);
      if (!ch || ch.kind !== "voice" || !this.store.isMember(ch.guildId, conn.userId)) fail("not_found", "Kanal bulunamadı.");
      const perms = this.store.perms(ch!.guildId, conn.userId);
      if (!has(perms, P.VIEW_CHANNELS) || !has(perms, P.CONNECT_VOICE)) fail("forbidden", "Bu sesli kanala katılma yetkin yok.");

      const old = this.peers.get(conn.userId);
      if (old) this.leave(old, old.conn === conn ? undefined : "replaced");

      const room = await this.room(ch!.id, ch!.guildId);
      const tunnel = p.transport === "ws";
      const [send, recv] = tunnel
        ? await Promise.all([room.router.createDirectTransport(), room.router.createDirectTransport()])
        : await Promise.all([this.transport(room.router, true), this.transport(room.router, false)]);
      const state: VoiceState = {
        userId: conn.userId, guildId: ch!.guildId, channelId: ch!.id,
        muted: !!p.muted, deafened: !!p.deafened, suppressed: !has(perms, P.SPEAK),
        joinedAt: Date.now(), stream: null,
      };
      const ws: WsLink | null = tunnel
        ? { ticket: randomToken(24), sock: null, nextTag: 1, micSsrc: (Math.random() * 0xffffffff) >>> 0, micSeq: 0, micTs: 0, sent: 0 }
        : null;
      const peer: Peer = { userId: conn.userId, conn, room, state, send, recv, ws, producers: new Map(), consumers: new Map(), watching: new Set() };
      if (this.closed || conn.ws.readyState !== 1) {
        send.close();
        recv.close();
        fail("bad_request", "Bağlantı kapandı.");
      }
      room.peers.set(conn.userId, peer);
      this.peers.set(conn.userId, peer);
      if (ws) {
        this.tickets.set(ws.ticket, peer);
        setTimeout(() => { if (this.tickets.get(ws.ticket) === peer) this.tickets.delete(ws.ticket); }, 30_000);
      }
      this.broadcastState(peer);

      const producers: RemoteProducer[] = [];
      for (const other of room.peers.values()) if (other !== peer) for (const e of other.producers.values()) producers.push(this.remote(other, e));
      return tunnel
        ? { state, rtpCapabilities: null, send: null, recv: null, producers, wsTicket: ws!.ticket }
        : { state, rtpCapabilities: room.router.rtpCapabilities, send: this.params(send as ms.WebRtcTransport), recv: this.params(recv as ms.WebRtcTransport), producers, wsTicket: null };
    },

    "voice.leave": (conn) => {
      const peer = this.peers.get(conn.userId);
      if (peer && peer.conn === conn) this.leave(peer);
      return null;
    },

    "voice.speaking": (conn, p) => {
      this.setSpeaking(this.peerOf(conn), p.speaking);
      return null;
    },

    "voice.update": (conn, p) => {
      const peer = this.peerOf(conn);
      peer.state = { ...peer.state, muted: p.muted ?? peer.state.muted, deafened: p.deafened ?? peer.state.deafened };
      if (peer.state.muted || peer.state.deafened) this.setSpeaking(peer, false);
      this.broadcastState(peer);
      return peer.state;
    },

    "media.connect": async (conn, p) => {
      const peer = this.peerOf(conn);
      const t = peer.send.id === p.transportId ? peer.send : peer.recv.id === p.transportId ? peer.recv : null;
      if (!t || peer.ws) fail("not_found", "Transport bulunamadı.");
      await (t as ms.WebRtcTransport).connect({ dtlsParameters: p.dtlsParameters as unknown as ms.DtlsParameters });
      return null;
    },

    "media.produce": async (conn, p) => {
      const peer = this.peerOf(conn);
      if (!peer.ws && p.transportId !== peer.send.id) fail("bad_request", "Yanlış transport.");
      if (peer.ws && p.source !== "mic") fail("forbidden", "Tünel modunda yayın açılamaz.");
      const perms = this.store.perms(peer.room.guildId, peer.userId);
      const wantKind = p.source === "screen" ? "video" : "audio";
      if (p.kind !== wantKind) fail("bad_request", "Kaynak türü uyuşmuyor.");
      if (p.source === "mic" && !has(perms, P.SPEAK)) fail("forbidden", "Bu kanalda konuşma yetkin yok.");
      if (p.source !== "mic" && !has(perms, P.STREAM)) fail("forbidden", "Yayın açma yetkin yok.");
      this.closeSource(peer, p.source); // one producer per source
      const producer = await peer.send.produce({
        kind: p.kind,
        // Tunnel mode: the server packetizes the client's Opus frames itself.
        rtpParameters: peer.ws
          ? { codecs: [{ mimeType: "audio/opus", payloadType: MIC_PT, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 } }], encodings: [{ ssrc: peer.ws.micSsrc }] }
          : (p.rtpParameters as unknown as ms.RtpParameters),
        appData: { userId: peer.userId, source: p.source },
      });
      if (this.peers.get(peer.userId) !== peer) {
        producer.close();
        fail("bad_request", "Sesli kanaldan ayrıldın.");
      }
      const entry: ProducerEntry = { producer, source: p.source };
      peer.producers.set(producer.id, entry);
      producer.on("transportclose", () => peer.producers.delete(producer.id));
      const remote = this.remote(peer, entry);
      for (const other of peer.room.peers.values()) if (other !== peer) this.toConn(other.conn, "media.producer", { ...remote, channelId: peer.room.channelId });
      return { id: producer.id };
    },

    "media.pauseProducer": async (conn, p) => {
      const peer = this.peerOf(conn);
      const e = peer.producers.get(p.producerId);
      if (!e) fail("not_found", "Producer bulunamadı.");
      if (p.paused) await e!.producer.pause();
      else await e!.producer.resume();
      for (const other of peer.room.peers.values()) if (other !== peer) this.toConn(other.conn, "media.producerPaused", { producerId: p.producerId, paused: p.paused });
      return null;
    },

    "media.closeProducer": (conn, p) => {
      const peer = this.peerOf(conn);
      const e = peer.producers.get(p.producerId);
      if (!e) return null;
      if (e.source === "screen") this.stopStream(peer);
      else {
        e.producer.close();
        this.producerGone(peer, p.producerId);
      }
      return null;
    },

    "media.consume": async (conn, p): Promise<ConsumerParams> => {
      const peer = this.peerOf(conn);
      let owner: Peer | null = null;
      let entry: ProducerEntry | undefined;
      for (const other of peer.room.peers.values()) {
        const e = other.producers.get(p.producerId);
        if (e) { owner = other; entry = e; break; }
      }
      if (!owner || !entry || owner === peer) fail("not_found", "Yayın kaynağı bulunamadı.");
      // Screen media flows only to people who pressed "watch" (bandwidth, CLAUDE.md §6.4).
      if (entry!.source !== "mic" && !peer.watching.has(owner!.userId)) fail("forbidden", "Önce yayını izlemeye başla.");
      const caps = peer.ws ? this.directCaps(peer.room.router) : (p.rtpCapabilities as unknown as ms.RtpCapabilities);
      if (!peer.room.router.canConsume({ producerId: p.producerId, rtpCapabilities: caps })) fail("bad_request", "Tarayıcın bu codec'i desteklemiyor.");
      const consumer = await peer.recv.consume({ producerId: p.producerId, rtpCapabilities: caps, paused: true });
      peer.consumers.set(consumer.id, consumer);
      const tag = peer.ws ? this.pipeToSocket(peer, consumer) : null;
      const gone = () => {
        if (!peer.consumers.delete(consumer.id)) return;
        this.toConn(peer.conn, "media.consumerClosed", { consumerId: consumer.id });
      };
      consumer.on("producerclose", gone);
      consumer.on("transportclose", () => peer.consumers.delete(consumer.id));
      return { id: consumer.id, producerId: p.producerId, userId: owner!.userId, source: entry!.source, kind: consumer.kind, rtpParameters: consumer.rtpParameters, tag };
    },

    "media.resume": async (conn, p) => {
      const c = this.peerOf(conn).consumers.get(p.consumerId);
      if (!c) fail("not_found", "Consumer bulunamadı.");
      await c!.resume();
      if (c!.kind === "video") await c!.requestKeyFrame().catch(() => {});
      return null;
    },

    "media.closeConsumer": (conn, p) => {
      const peer = this.peerOf(conn);
      const c = peer.consumers.get(p.consumerId);
      if (c) {
        peer.consumers.delete(c.id);
        c.close();
      }
      return null;
    },

    "media.layers": async (conn, p) => {
      const c = this.peerOf(conn).consumers.get(p.consumerId);
      if (c?.type === "simulcast") await c.setPreferredLayers({ spatialLayer: p.spatial });
      return null;
    },

    "stream.start": (conn, p) => {
      const peer = this.peerOf(conn);
      if (![...peer.producers.values()].some((e) => e.source === "screen")) fail("bad_request", "Önce ekran kaynağı gönderilmeli.");
      const thumb = this.thumbs.get(peer.userId);
      peer.state = {
        ...peer.state,
        stream: {
          startedAt: peer.state.stream?.startedAt ?? Date.now(),
          width: p.width, height: p.height, fps: p.fps, audio: p.audio,
          thumbnail: peer.state.stream?.thumbnail ?? (thumb ? `/thumbs/${thumb.id}.jpg` : null),
          viewers: peer.state.stream?.viewers ?? [],
          controllerId: peer.state.stream?.controllerId ?? null,
        },
      };
      this.broadcastState(peer);
      return peer.state;
    },

    "stream.stop": (conn) => {
      this.stopStream(this.peerOf(conn));
      return null;
    },

    "remote.request": (conn, p) => {
      const peer = this.peerOf(conn);
      const target = peer.room.peers.get(p.userId);
      if (!target?.state.stream) fail("not_found", "Bu yayın artık yok.");
      if (target === peer || !peer.watching.has(target!.userId)) fail("bad_request", "Önce yayını izlemelisin.");
      if (!this.rcEligible(peer) || !has(this.store.perms(peer.room.guildId, peer.userId), P.REQUEST_REMOTE_CONTROL)) fail("forbidden", "Uzaktan kontrol isteyemezsin.");
      if (!this.rcEligible(target!)) fail("forbidden", "Bu yayın uzaktan kontrolü desteklemiyor.");
      if (target!.state.stream!.controllerId === peer.userId) return null;
      const key = `${peer.userId}>${target!.userId}`;
      if (Date.now() - (this.rcLastRequest.get(key) ?? 0) < 5000) fail("rate_limited", "Biraz bekle.");
      this.rcLastRequest.set(key, Date.now());
      this.toConn(target!.conn, "remote.request", { userId: peer.userId });
      return null;
    },

    "remote.respond": (conn, p) => {
      const peer = this.peerOf(conn);
      if (!peer.state.stream) fail("bad_request", "Yayın açık değil.");
      const viewer = peer.room.peers.get(p.userId);
      if (!viewer || viewer === peer) fail("not_found", "Bu kişi kanalda değil.");
      if (p.allow) {
        if (!viewer!.watching.has(peer.userId)) fail("bad_request", "Bu kişi yayını izlemiyor.");
        if (!this.rcEligible(peer) || !this.rcEligible(viewer!) || !has(this.store.perms(peer.room.guildId, viewer!.userId), P.REQUEST_REMOTE_CONTROL)) {
          fail("forbidden", "Bu kişiye kontrol verilemez.");
        }
        this.setController(peer, viewer!.userId, "granted");
      }
      this.toConn(viewer!.conn, "remote.answer", { streamerId: peer.userId, allow: p.allow });
      return null;
    },

    "remote.stop": (conn, p) => {
      const peer = this.peerOf(conn);
      const streamer = peer.room.peers.get(p.streamerId);
      const c = streamer?.state.stream?.controllerId;
      if (!streamer || !c) return null;
      if (peer !== streamer && peer.userId !== c) fail("forbidden", "Bu kontrol oturumu senin değil.");
      this.setController(streamer, null, peer === streamer ? "revoked" : "released");
      return null;
    },

    "stream.watch": (conn, p) => {
      const peer = this.peerOf(conn);
      const target = peer.room.peers.get(p.userId);
      if (!target?.state.stream) fail("not_found", "Bu yayın artık yok.");
      if (target === peer) fail("bad_request", "Kendi yayınını izleyemezsin.");
      const s = target!.state.stream!;
      const viewers = s.viewers.filter((v) => v !== peer.userId);
      if (p.watching) {
        viewers.push(peer.userId);
        peer.watching.add(target!.userId);
      } else {
        peer.watching.delete(target!.userId);
        // Close this viewer's consumers of the streamer's screen producers.
        const screenIds = new Set([...target!.producers.values()].filter((e) => e.source !== "mic").map((e) => e.producer.id));
        for (const c of [...peer.consumers.values()]) {
          if (!screenIds.has(c.producerId)) continue;
          peer.consumers.delete(c.id);
          c.close();
        }
      }
      const controllerId = !p.watching && s.controllerId === peer.userId ? null : s.controllerId;
      if (controllerId !== s.controllerId) this.log(`[remote] ${this.name(peer.userId)} stopped controlling ${this.name(target!.userId)} (stopped watching)`);
      target!.state = { ...target!.state, stream: { ...s, viewers, controllerId } };
      this.broadcastState(target!);
      return p.watching ? [...target!.producers.values()].filter((e) => e.source !== "mic").map((e) => this.remote(target!, e)) : [];
    },
  };
}
