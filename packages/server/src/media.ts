import os from "node:os";
import * as mediasoup from "mediasoup";
import type { types as ms } from "mediasoup";
import {
  P, has,
  type ConsumerParams, type EventName, type Events, type MediaMethodName, type MediaSource, type MethodName, type MethodResults,
  type RemoteProducer, type TransportParams, type VoiceJoinResult, type VoiceState,
} from "@nooxcord/shared";
import { Methods } from "@nooxcord/shared/schemas";
import type { Conn, Hub } from "./hub";
import type { Store } from "./store";
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

interface Peer {
  userId: string;
  conn: Conn;
  room: Room;
  state: VoiceState;
  send: ms.WebRtcTransport;
  recv: ms.WebRtcTransport;
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
  private closed = false;

  constructor(private store: Store, private hub: Hub, private port: number, private bind?: string, private log: (...a: unknown[]) => void = () => {}) {}

  // ---------- public API used by the host ----------

  isMediaMethod(m: string): boolean {
    return m.startsWith("voice.") || m.startsWith("media.") || m.startsWith("stream.");
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
      }
    }
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

  private stopStream(p: Peer): void {
    this.closeSource(p, "screen");
    this.closeSource(p, "screen-audio");
    this.thumbs.delete(p.userId);
    if (!p.state.stream) return;
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
    if (reason && !silent) this.toConn(p.conn, "voice.ended", { reason });
    if (room.speaking.includes(p.userId)) {
      room.speaking = room.speaking.filter((id) => id !== p.userId);
      if (!silent && room.peers.size > 0) this.toGuild(room.guildId, "voice.speaking", { channelId: room.channelId, userIds: room.speaking });
    }
    // Stop counting this peer as a viewer.
    for (const streamer of p.watching) {
      const s = room.peers.get(streamer);
      if (s?.state.stream) {
        s.state = { ...s.state, stream: { ...s.state.stream, viewers: s.state.stream.viewers.filter((v) => v !== p.userId) } };
        if (!silent) this.broadcastState(s);
      }
    }
    if (!silent && !this.closed) this.toGuild(room.guildId, "voice.leave", { guildId: room.guildId, channelId: room.channelId, userId: p.userId });
    if (room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(room.channelId);
    }
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
      const [send, recv] = await Promise.all([this.transport(room.router, true), this.transport(room.router, false)]);
      const state: VoiceState = {
        userId: conn.userId, guildId: ch!.guildId, channelId: ch!.id,
        muted: !!p.muted, deafened: !!p.deafened, suppressed: !has(perms, P.SPEAK),
        joinedAt: Date.now(), stream: null,
      };
      const peer: Peer = { userId: conn.userId, conn, room, state, send, recv, producers: new Map(), consumers: new Map(), watching: new Set() };
      if (this.closed || conn.ws.readyState !== 1) {
        send.close();
        recv.close();
        fail("bad_request", "Bağlantı kapandı.");
      }
      room.peers.set(conn.userId, peer);
      this.peers.set(conn.userId, peer);
      this.broadcastState(peer);

      const producers: RemoteProducer[] = [];
      for (const other of room.peers.values()) if (other !== peer) for (const e of other.producers.values()) producers.push(this.remote(other, e));
      return { state, rtpCapabilities: room.router.rtpCapabilities, send: this.params(send), recv: this.params(recv), producers };
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
      if (!t) fail("not_found", "Transport bulunamadı.");
      await t!.connect({ dtlsParameters: p.dtlsParameters as unknown as ms.DtlsParameters });
      return null;
    },

    "media.produce": async (conn, p) => {
      const peer = this.peerOf(conn);
      if (p.transportId !== peer.send.id) fail("bad_request", "Yanlış transport.");
      const perms = this.store.perms(peer.room.guildId, peer.userId);
      const wantKind = p.source === "screen" ? "video" : "audio";
      if (p.kind !== wantKind) fail("bad_request", "Kaynak türü uyuşmuyor.");
      if (p.source === "mic" && !has(perms, P.SPEAK)) fail("forbidden", "Bu kanalda konuşma yetkin yok.");
      if (p.source !== "mic" && !has(perms, P.STREAM)) fail("forbidden", "Yayın açma yetkin yok.");
      this.closeSource(peer, p.source); // one producer per source
      const producer = await peer.send.produce({
        kind: p.kind,
        rtpParameters: p.rtpParameters as unknown as ms.RtpParameters,
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
      const caps = p.rtpCapabilities as unknown as ms.RtpCapabilities;
      if (!peer.room.router.canConsume({ producerId: p.producerId, rtpCapabilities: caps })) fail("bad_request", "Tarayıcın bu codec'i desteklemiyor.");
      const consumer = await peer.recv.consume({ producerId: p.producerId, rtpCapabilities: caps, paused: true });
      peer.consumers.set(consumer.id, consumer);
      const gone = () => {
        if (!peer.consumers.delete(consumer.id)) return;
        this.toConn(peer.conn, "media.consumerClosed", { consumerId: consumer.id });
      };
      consumer.on("producerclose", gone);
      consumer.on("transportclose", () => peer.consumers.delete(consumer.id));
      return { id: consumer.id, producerId: p.producerId, userId: owner!.userId, source: entry!.source, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
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
        },
      };
      this.broadcastState(peer);
      return peer.state;
    },

    "stream.stop": (conn) => {
      this.stopStream(this.peerOf(conn));
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
      target!.state = { ...target!.state, stream: { ...s, viewers } };
      this.broadcastState(target!);
      return p.watching ? [...target!.producers.values()].filter((e) => e.source !== "mic").map((e) => this.remote(target!, e)) : [];
    },
  };
}
