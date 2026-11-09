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
import { FRAME_CAM, FRAME_KEYREQ, FRAME_MIC, FRAME_SCREEN, FRAME_SCREEN_AUDIO, FrameAssembler, audioFrame, buildRtp, keyFrameSsrcs, packetizeH264, parseRtp, videoFrame } from "./rtp";
import { fail, randomToken } from "./util";

/** Above-normal CPU priority (no admin needed); best effort. 0 = this process. */
export function raisePriority(pid: number): void {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch { /* not permitted: keep normal */ }
}

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

const isScreen = (s: MediaSource): boolean => s === "screen" || s === "screen-audio";

/** Tunnel-mode (NXM-WS) state of a peer: media goes over a WebSocket instead of WebRTC. */
interface WsLink {
  ticket: string;
  sock: WebSocket | null;
  nextTag: number;
  /** Client-encoded Opus: [0] microphone, [1] stream audio. */
  aud: [WsAudioIn, WsAudioIn];
  /** Browser-encoded H.264: [0] camera, [1] screen. */
  vid: [WsVideoIn, WsVideoIn];
  sent: number;
  /** Measured delivery rate (bytes/s that left the socket buffer), for a time-based backlog limit. */
  rate: number;
  rateAt: number;
  drainedAt: number;
}

interface WsAudioIn { ssrc: number; seq: number; ts: number }
const WS_AUDIO_SOURCES = ["mic", "screen-audio"] as const;
interface WsVideoIn { ssrc: number; seq: number; lastKeyReq: number }
const WS_VIDEO_SOURCES = ["camera", "screen"] as const;

const MIC_PT = 100;
const CAM_PT = 101;
/** Tunnel-mode cameras and screens are encoded by WebCodecs in the browser: H.264 constrained baseline. */
const CAM_H264 = { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 };
/*
 * Tunnel-mode backlog: how much may wait on a viewer's socket before frames are dropped. Measured in
 * time at the viewer's real delivery rate, not bytes: 1.5 MB on a 500 kbps link was 24 s of video, and
 * because audio shares the socket (TCP), voice and stream audio queued behind it -> late bursts on the
 * phone (crackle) and video seconds behind the sound after a network hiccup.
 * The byte floor lets a whole key frame through even when the rate is still unknown.
 */
const VIDEO_BACKLOG_S = 0.4, VIDEO_BACKLOG_MIN = 250_000; // then skip to the next key frame
const AUDIO_BACKLOG_S = 1.2, AUDIO_BACKLOG_MIN = 300_000;
const TUNNEL_HIGH_RETRY = 20_000; // after a tunnel viewer fell behind on the full layer, small layer this long

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
  /** Addresses the current WebRtcServer listens on. */
  private listening: string[] = [];
  private rooms = new Map<string, Room>();
  private peers = new Map<string, Peer>();
  private thumbs = new Map<string, Thumb>(); // userId -> latest stream thumbnail
  private tickets = new Map<string, Peer>();
  private closed = false;
  /** Tunnel consumers of screen streams: re-applies the streamer's layer choice. */
  private layerPickers = new Map<string, () => void>();
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
        if (!has(perms, P.VIDEO) && p.state.camera) this.closeSource(p, "camera");
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
      if (!isBinary || data.length < 2) return;
      if (data[0] === FRAME_MIC) this.audioIn(peer, data.subarray(1), 0);
      else if (data[0] === FRAME_SCREEN_AUDIO) this.audioIn(peer, data.subarray(1), 1);
      else if (data[0] === FRAME_CAM && data.length > 6) this.videoIn(peer, data, 0);
      else if (data[0] === FRAME_SCREEN && data.length > 6) this.videoIn(peer, data, 1);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      clearInterval(ping);
      if (peer?.ws?.sock === ws) peer.ws.sock = null;
    });
  }

  /** Tunnel-mode microphone / stream audio: one 20 ms Opus frame -> one RTP packet. */
  private audioIn(p: Peer, opus: Buffer, which: 0 | 1): void {
    const a = p.ws!.aud[which];
    const e = [...p.producers.values()].find((x) => x.source === WS_AUDIO_SOURCES[which]);
    if (!e || e.producer.paused) return;
    a.seq = (a.seq + 1) & 0xffff;
    a.ts = (a.ts + 960) >>> 0; // 20 ms at 48 kHz
    try {
      e.producer.send(buildRtp(MIC_PT, a.seq, a.ts, a.ssrc, opus));
    } catch { /* producer closing */ }
  }

  /** Tunnel-mode camera / screen: one Annex-B access unit -> RTP packets into the matching producer. */
  private videoIn(p: Peer, data: Buffer, which: 0 | 1): void {
    const v = p.ws!.vid[which];
    const e = [...p.producers.values()].find((x) => x.source === WS_VIDEO_SOURCES[which]);
    if (!e || e.producer.paused) return;
    const ts = data.readUInt32BE(2);
    const payloads = packetizeH264(data.subarray(6));
    try {
      payloads.forEach((pl, i) => {
        v.seq = (v.seq + 1) & 0xffff;
        e.producer.send(buildRtp(CAM_PT, v.seq, ts, v.ssrc, pl, i === payloads.length - 1));
      });
    } catch { /* producer closing */ }
  }

  /** Sends a frame to a tunnel-mode peer; false when the socket is too far behind. */
  private wsSend(p: Peer, buf: Buffer, kind: "audio" | "video"): boolean {
    const ws = p.ws;
    const sock = ws?.sock;
    if (!ws || !sock || sock.readyState !== 1) return false;
    const queued = sock.bufferedAmount;
    const now = Date.now();
    if (now - ws.rateAt >= 500) { // delivery rate, smoothed
      const drained = ws.sent - queued;
      const r = ((drained - ws.drainedAt) * 1000) / (now - ws.rateAt);
      ws.rate = ws.rate ? ws.rate * 0.7 + r * 0.3 : r;
      ws.rateAt = now;
      ws.drainedAt = drained;
    }
    const limit = kind === "video"
      ? Math.max(VIDEO_BACKLOG_MIN, ws.rate * VIDEO_BACKLOG_S)
      : Math.max(AUDIO_BACKLOG_MIN, ws.rate * AUDIO_BACKLOG_S);
    if (queued > limit) return false;
    sock.send(buf);
    ws.sent += buf.length;
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
    // A network interface came or went (Hamachi connected later, Wi-Fi changed) while nobody is in voice:
    // restart the media server so its ICE candidates match the machine's current addresses.
    if (this.webRtcServer && this.rooms.size === 0 && listenIps(this.bind).join() !== this.listening.join()) {
      this.log(`[media] network changed (${this.listening.join(", ")} -> ${listenIps(this.bind).join(", ")}), restarting`);
      const w = this.worker;
      this.worker = null;
      this.webRtcServer = null;
      w?.close();
    }
    if (this.webRtcServer) return;
    this.starting ??= (async () => {
      const worker = await mediasoup.createWorker({ logLevel: "warn", rtcMinPort: 0, rtcMaxPort: 0 });
      // Every voice and stream packet of the room passes through this process. A game on the host PC
      // starved it at normal priority (jitter → robotic / crackling audio for everyone): run it higher.
      raisePriority(worker.pid);
      worker.on("died", (err) => {
        this.log("[media] worker died", err);
        if (this.worker !== worker) return;
        this.worker = null;
        this.webRtcServer = null;
        // Not silent: clients must learn their session is gone, or they sit in a dead call (they rejoin).
        for (const p of [...this.peers.values()]) this.leave(p, "error");
        this.rooms.clear();
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
      this.listening = ips;
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
    const e = p.producers.get(producerId);
    p.producers.delete(producerId);
    for (const other of p.room.peers.values()) if (other !== p) this.toConn(other.conn, "media.producerClosed", { producerId });
    if (e?.source === "camera" && p.state.camera && this.peers.get(p.userId) === p) {
      p.state = { ...p.state, camera: false };
      this.broadcastState(p);
    }
  }

  /** Can this streamer be controlled? Only the desktop app injects input, and never for a guest (CLAUDE.md 7.3). */
  private rcStreamer(p: Peer): boolean {
    return p.conn.desktop && this.store.userRow(p.userId)?.guest !== 1;
  }

  /** May this viewer control a stream? Any client, browser guests included, when a role grants it. */
  private rcViewer(p: Peer): boolean {
    return has(this.store.perms(p.room.guildId, p.userId), P.REQUEST_REMOTE_CONTROL);
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
        if (r && r.payload.length > 0) this.wsSend(peer, audioFrame(tag, r.timestamp, r.payload), "audio");
      });
      return tag;
    }
    const vp8 = mime === "video/vp8";
    // Simulcast layer for this viewer: the streamer chooses (StreamInfo.tunnelHigh); a viewer that cannot
    // keep up with the full layer drops to the small one for a while, then tries again.
    let downUntil = 0;
    let retry: NodeJS.Timeout | null = null;
    const pickLayer = () => {
      if (consumer.type !== "simulcast" || consumer.closed) return;
      const high = this.tunnelHighFor(peer, consumer.producerId) && Date.now() >= downUntil;
      consumer.setPreferredLayers({ spatialLayer: high ? 1 : 0 }).catch(() => {});
    };
    const fellBehind = () => {
      if (consumer.type !== "simulcast" || !this.tunnelHighFor(peer, consumer.producerId) || Date.now() < downUntil) return;
      downUntil = Date.now() + TUNNEL_HIGH_RETRY;
      pickLayer();
      if (retry) clearTimeout(retry);
      retry = setTimeout(pickLayer, TUNNEL_HIGH_RETRY + 50);
    };
    this.layerPickers.set(consumer.id, pickLayer);
    consumer.observer.once("close", () => {
      this.layerPickers.delete(consumer.id);
      if (retry) clearTimeout(retry);
    });
    let lastKeyReq = 0;
    const needKey = () => {
      const now = Date.now();
      if (now - lastKeyReq < 1000) return;
      lastKeyReq = now;
      consumer.requestKeyFrame().catch(() => {});
    };
    const asm = new FrameAssembler(vp8 ? "vp8" : "h264", (f) => {
      if (!this.wsSend(peer, videoFrame(tag, f, vp8), "video")) {
        fellBehind();
        asm.skipToKey();
        needKey();
      }
    }, needKey);
    consumer.on("rtp", (b: Buffer) => {
      const r = parseRtp(b);
      if (r) asm.push(r);
    });
    pickLayer();
    return tag;
  }

  /** Does the owner of this producer want tunnel viewers on the full layer? */
  private tunnelHighFor(viewer: Peer, producerId: string): boolean {
    for (const p of viewer.room.peers.values()) if (p.producers.has(producerId)) return !!p.state.stream?.tunnelHigh;
    return false;
  }

  /** Re-applies the layer choice to every tunnel consumer of this streamer's screen. */
  private repickLayers(streamer: Peer): void {
    const ids = new Set([...streamer.producers.values()].filter((e) => e.source === "screen").map((e) => e.producer.id));
    for (const other of streamer.room.peers.values()) {
      if (!other.ws) continue;
      for (const c of other.consumers.values()) if (ids.has(c.producerId)) this.layerPickers.get(c.id)?.();
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
      const tunnel = p.transport === "ws";
      const [send, recv] = tunnel
        ? await Promise.all([room.router.createDirectTransport(), room.router.createDirectTransport()])
        : await Promise.all([this.transport(room.router, true), this.transport(room.router, false)]);
      const state: VoiceState = {
        userId: conn.userId, guildId: ch!.guildId, channelId: ch!.id,
        muted: !!p.muted, deafened: !!p.deafened, suppressed: !has(perms, P.SPEAK),
        joinedAt: Date.now(), stream: null, camera: false,
      };
      const ws: WsLink | null = tunnel
        ? {
          ticket: randomToken(24), sock: null, nextTag: 1, aud: [0, 1].map(() => ({ ssrc: (Math.random() * 0xffffffff) >>> 0, seq: 0, ts: 0 })) as [WsAudioIn, WsAudioIn],
          vid: [0, 1].map(() => ({ ssrc: (Math.random() * 0xffffffff) >>> 0, seq: 0, lastKeyReq: 0 })) as [WsVideoIn, WsVideoIn], sent: 0, rate: 0, rateAt: Date.now(), drainedAt: 0,
        }
        : null;
      if (ws) {
        // Viewers lost a frame (PLI/FIR from the router): ask the browser's encoder for a key frame.
        (send as ms.DirectTransport).on("rtcp", (b: Buffer) => {
          const now = Date.now();
          for (const ssrc of new Set(keyFrameSsrcs(b))) {
            const which = ws.vid.findIndex((v) => v.ssrc === ssrc);
            const v = ws.vid[which];
            if (!v || now - v.lastKeyReq < 300) continue;
            v.lastKeyReq = now;
            const sock = ws.sock;
            if (sock && sock.readyState === 1) sock.send(Buffer.from([FRAME_KEYREQ, which]));
          }
        });
      }
      const peer: Peer = { userId: conn.userId, conn, room, state, send, recv, ws, producers: new Map(), consumers: new Map(), watching: new Set() };
      if (this.closed || conn.ws.readyState !== 1) {
        send.close();
        recv.close();
        fail("bad_request", "Bağlantı kapandı.");
      }
      room.peers.set(conn.userId, peer);
      this.peers.set(conn.userId, peer);
      this.log(`[voice] ${this.name(conn.userId)} joined ${ch!.name} via ${p.transport ?? "rtc"}${conn.desktop ? " (desktop)" : ""}`);
      if (!tunnel) {
        for (const [dir, t] of [["send", send], ["recv", recv]] as [string, ms.WebRtcTransport][]) {
          // Which address pair carries the media (Hamachi 25.x, LAN, TCP?) — needed to tell network problems apart.
          t.on("iceselectedtuplechange", (tu) => this.log(`[voice] ${this.name(conn.userId)} ${dir} media via ${tu.protocol} ${tu.localAddress}:${tu.localPort} <-> ${tu.remoteIp}:${tu.remotePort}`));
          t.on("icestatechange", (st) => { if (st === "disconnected") this.log(`[voice] ${this.name(conn.userId)} ICE disconnected`); });
          t.on("dtlsstatechange", (st) => { if (st === "failed" || st === "closed") this.log(`[voice] ${this.name(conn.userId)} DTLS ${st}`); });
        }
      }
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
      const perms = this.store.perms(peer.room.guildId, peer.userId);
      const wantKind = p.source === "screen" || p.source === "camera" ? "video" : "audio";
      if (p.kind !== wantKind) fail("bad_request", "Kaynak türü uyuşmuyor.");
      if (p.source === "mic" && !has(perms, P.SPEAK)) fail("forbidden", "Bu kanalda konuşma yetkin yok.");
      if (p.source === "camera" && !has(perms, P.VIDEO)) fail("forbidden", "Kamera açma yetkin yok.");
      if (isScreen(p.source) && !has(perms, P.STREAM)) fail("forbidden", "Yayın açma yetkin yok.");
      this.closeSource(peer, p.source); // one producer per source
      const producer = await peer.send.produce({
        kind: p.kind,
        // Tunnel mode: the server packetizes the client's Opus / H.264 frames itself.
        rtpParameters: peer.ws
          ? p.source === "camera" || p.source === "screen"
            ? {
              codecs: [{ mimeType: "video/H264", payloadType: CAM_PT, clockRate: 90000, parameters: CAM_H264, rtcpFeedback: [{ type: "nack", parameter: "pli" }, { type: "ccm", parameter: "fir" }] }],
              encodings: [{ ssrc: peer.ws.vid[p.source === "camera" ? 0 : 1].ssrc }],
            }
            : p.source === "screen-audio"
              ? { codecs: [{ mimeType: "audio/opus", payloadType: MIC_PT, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1, stereo: 1, "sprop-stereo": 1 } }], encodings: [{ ssrc: peer.ws.aud[1].ssrc }] }
              : { codecs: [{ mimeType: "audio/opus", payloadType: MIC_PT, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1 } }], encodings: [{ ssrc: peer.ws.aud[0].ssrc }] }
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
      if (p.source === "camera" && !peer.state.camera) {
        peer.state = { ...peer.state, camera: true };
        this.broadcastState(peer);
      }
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
      // Cameras are small and go to everyone in the channel, like voices.
      if (isScreen(entry!.source) && !peer.watching.has(owner!.userId)) fail("forbidden", "Önce yayını izlemeye başla.");
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
          controllable: this.rcStreamer(peer),
          tunnelHigh: p.tunnelHigh ?? peer.state.stream?.tunnelHigh ?? false,
        },
      };
      this.broadcastState(peer);
      this.repickLayers(peer);
      return peer.state;
    },

    "stream.tunnelQuality": (conn, p) => {
      const peer = this.peerOf(conn);
      const s = peer.state.stream;
      if (!s) fail("bad_request", "Yayın açık değil.");
      if (s!.tunnelHigh === p.high) return null;
      peer.state = { ...peer.state, stream: { ...s!, tunnelHigh: p.high } };
      this.broadcastState(peer);
      this.repickLayers(peer);
      return null;
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
      if (!this.rcViewer(peer)) fail("forbidden", "Uzaktan kontrol isteyemezsin.");
      if (!this.rcStreamer(target!)) fail("forbidden", "Bu yayın uzaktan kontrolü desteklemiyor.");
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
        if (!this.rcStreamer(peer) || !this.rcViewer(viewer!)) {
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
        const screenIds = new Set([...target!.producers.values()].filter((e) => isScreen(e.source)).map((e) => e.producer.id));
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
      return p.watching ? [...target!.producers.values()].filter((e) => isScreen(e.source)).map((e) => this.remote(target!, e)) : [];
    },
  };
}
