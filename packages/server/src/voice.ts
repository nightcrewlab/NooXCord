import {
  LIMITS, P, has,
  type EventName, type Events, type IceServer, type MediaMethodName, type MethodName, type MethodResults, type VoiceJoinResult, type VoiceState,
} from "@nooxcord/shared";
import { Methods, RemoteInput } from "@nooxcord/shared/schemas";
import type { Conn, Hub } from "./hub";
import type { Store } from "./store";
import { fail, randomToken } from "./util";

/*
 * Voice channels with peer-to-peer media (ADR 0003). The host never carries audio or video: it keeps
 * who is in which channel (VoiceState: mute, camera, stream, viewers, remote control) and relays WebRTC
 * signalling ("rtc.signal") between two people in the same channel. A user has at most one voice
 * session, bound to the socket that joined; when that socket closes the session ends.
 *
 * Permissions the host cannot enforce on media itself are enforced by the clients from the state it
 * publishes: nobody plays a voice marked "suppressed", screens go only to the stream's viewers.
 */

const CALL_GRACE = 30_000;

interface Peer {
  userId: string;
  conn: Conn;
  room: Room;
  state: VoiceState;
  /** Streamers this peer is watching. */
  watching: Set<string>;
  /** Signals relayed in the current second (rate limit). */
  sig: { at: number; n: number };
}

interface Room {
  channelId: string;
  guildId: string;
  /** Call start (shown as a live timer). */
  since: number;
  peers: Map<string, Peer>;
  speaking: string[];
}

interface Thumb { id: string; buf: Buffer }

type Params<M extends MethodName> = ReturnType<(typeof Methods)[M]["parse"]>;

export class Voice {
  private rooms = new Map<string, Room>();
  /** Call start of rooms that just emptied: a rejoin within CALL_GRACE keeps the timer running. */
  private endedCalls = new Map<string, { since: number; at: number }>();
  private peers = new Map<string, Peer>();
  private thumbs = new Map<string, Thumb>(); // userId -> latest stream thumbnail
  private closed = false;
  /** Remote control: last input per streamer, last request per viewer>streamer pair, input rate per viewer. */
  private rcLastInput = new Map<string, number>();
  private rcLastRequest = new Map<string, number>();
  private rcRate = new Map<string, { at: number; n: number }>();
  private rcTimer = setInterval(() => this.rcSweep(), 30_000);

  constructor(private store: Store, private hub: Hub, private iceServers: () => Promise<IceServer[]> | IceServer[], private log: (...a: unknown[]) => void = () => {}) {}

  // ---------- public API used by the host ----------

  isMediaMethod(m: string): boolean {
    return m.startsWith("voice.") || m.startsWith("rtc.") || m.startsWith("stream.") || m.startsWith("remote.");
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
        let changed = suppressed !== p.state.suppressed;
        p.state = { ...p.state, suppressed };
        if (!has(perms, P.STREAM) && p.state.stream) this.stopStream(p);
        if (!has(perms, P.VIDEO) && p.state.camera) { p.state = { ...p.state, camera: false }; changed = true; }
        if (!has(perms, P.REQUEST_REMOTE_CONTROL)) {
          for (const s of r.peers.values()) if (s.state.stream?.controllerId === p.userId) this.setController(s, null, "permission");
        }
        if (changed) this.broadcastState(p);
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
  }

  // ---------- internals ----------

  private room(channelId: string, guildId: string): Room {
    let r = this.rooms.get(channelId);
    if (r) return r;
    const ended = this.endedCalls.get(channelId);
    const since = ended && Date.now() - ended.at < CALL_GRACE ? ended.since : Date.now();
    this.endedCalls.delete(channelId);
    r = { channelId, guildId, since, peers: new Map(), speaking: [] };
    this.rooms.set(channelId, r);
    return r;
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

  /*
   * Speaking indicator: each client reports its own voice-activity gate (the same gate that decides
   * whether its microphone sends sound), the single source of truth.
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
      this.rooms.delete(room.channelId);
      const now = Date.now();
      for (const [id, e] of this.endedCalls) if (now - e.at > CALL_GRACE) this.endedCalls.delete(id);
      this.endedCalls.set(room.channelId, { since: room.since, at: now });
    }
  }

  private handlers: { [M in MediaMethodName]: (conn: Conn, p: Params<M>) => unknown } = {
    "voice.join": async (conn, p): Promise<VoiceJoinResult> => {
      const ch = this.store.channel(p.channelId);
      if (!ch || ch.kind !== "voice" || !this.store.isMember(ch.guildId, conn.userId)) fail("not_found", "Kanal bulunamadı.");
      const perms = this.store.perms(ch!.guildId, conn.userId);
      if (!has(perms, P.VIEW_CHANNELS) || !has(perms, P.CONNECT_VOICE)) fail("forbidden", "Bu sesli kanala katılma yetkin yok.");
      const iceServers = await this.iceServers();
      if (this.closed || conn.ws.readyState !== 1) fail("bad_request", "Bağlantı kapandı.");

      const old = this.peers.get(conn.userId);
      if (old) this.leave(old, old.conn === conn ? undefined : "replaced");

      const room = this.room(ch!.id, ch!.guildId);
      const state: VoiceState = {
        userId: conn.userId, guildId: ch!.guildId, channelId: ch!.id,
        muted: !!p.muted, deafened: !!p.deafened, suppressed: !has(perms, P.SPEAK),
        joinedAt: Date.now(), callSince: room.since, stream: null, camera: false,
      };
      const peer: Peer = { userId: conn.userId, conn, room, state, watching: new Set(), sig: { at: 0, n: 0 } };
      const peers = [...room.peers.values()].map((x) => x.state);
      room.peers.set(conn.userId, peer);
      this.peers.set(conn.userId, peer);
      this.log(`[voice] ${this.name(conn.userId)} joined ${ch!.name}${conn.desktop ? " (desktop)" : ""}, ${peers.length} already there`);
      this.broadcastState(peer);
      return { state, peers, iceServers };
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
      if (p.camera && !has(this.store.perms(peer.room.guildId, peer.userId), P.VIDEO)) fail("forbidden", "Kamera açma yetkin yok.");
      peer.state = { ...peer.state, muted: p.muted ?? peer.state.muted, deafened: p.deafened ?? peer.state.deafened, camera: p.camera ?? peer.state.camera };
      if (peer.state.muted || peer.state.deafened) this.setSpeaking(peer, false);
      this.broadcastState(peer);
      return peer.state;
    },

    "rtc.signal": (conn, p) => {
      const peer = this.peerOf(conn);
      const target = peer.room.peers.get(p.to);
      if (!target || target === peer) return null; // left meanwhile: nothing to do
      const now = Date.now();
      if (now - peer.sig.at >= 1000) peer.sig = { at: now, n: 0 };
      if (++peer.sig.n > 100) fail("rate_limited", "Çok hızlı.");
      this.toConn(target.conn, "rtc.signal", {
        from: peer.userId, gen: p.gen,
        ...(p.description ? { description: p.description } : {}),
        ...(p.candidate !== undefined ? { candidate: p.candidate } : {}),
      });
      return null;
    },

    "stream.start": (conn, p) => {
      const peer = this.peerOf(conn);
      if (!has(this.store.perms(peer.room.guildId, peer.userId), P.STREAM)) fail("forbidden", "Yayın açma yetkin yok.");
      const thumb = this.thumbs.get(peer.userId);
      const fresh = !peer.state.stream;
      peer.state = {
        ...peer.state,
        stream: {
          startedAt: peer.state.stream?.startedAt ?? Date.now(),
          width: p.width, height: p.height, fps: p.fps, audio: p.audio,
          thumbnail: peer.state.stream?.thumbnail ?? (thumb ? `/thumbs/${thumb.id}.jpg` : null),
          viewers: peer.state.stream?.viewers ?? [],
          controllerId: peer.state.stream?.controllerId ?? null,
          controllable: this.rcStreamer(peer),
          ...(p.codec ? { codec: p.codec } : {}),
        },
      };
      if (fresh) this.log(`[stream] ${this.name(peer.userId)} started ${p.width}x${p.height}@${p.fps}${p.codec ? ` ${p.codec}` : ""}`);
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
      } else peer.watching.delete(target!.userId);
      const controllerId = !p.watching && s.controllerId === peer.userId ? null : s.controllerId;
      if (controllerId !== s.controllerId) this.log(`[remote] ${this.name(peer.userId)} stopped controlling ${this.name(target!.userId)} (stopped watching)`);
      target!.state = { ...target!.state, stream: { ...s, viewers, controllerId } };
      this.broadcastState(target!);
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
  };
}
