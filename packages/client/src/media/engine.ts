import { denoise, type Denoised } from "./denoise";
import { remote, useRemote } from "./remote";
import { create } from "zustand";
import { STREAM_PRESETS, type EventName, type Events, type IceServer, type MediaSource, type StreamPreset, type VoiceState } from "@nooxcord/shared";
import type { HostConnection } from "../net/connection";
import { platform } from "../platform";
import { useStore } from "../state/store";
import { VadGate, audioContext, idleMicContext, meter, micContext, type LevelMeter } from "./level";
import { pcmTrack, type PcmTrack } from "./pcm";
import { voiceSettings, useVoiceSettings, type StreamCodec } from "./settings";
import { t } from "../i18n";
import { startBackgroundCall, stopBackgroundCall } from "./background";

/*
 * Voice & stream engine, peer to peer (ADR 0003). Everyone in a voice channel has one
 * RTCPeerConnection to everyone else; the host only relays the offer / answer / ICE candidates
 * ("rtc.signal"). Each connection carries four fixed transceivers in this order:
 *   0 microphone · 1 camera · 2 screen · 3 screen audio
 * Tracks are switched with replaceTrack, so a connection is negotiated once. A screen goes only to
 * the people watching it (my StreamInfo.viewers). The smaller user id makes the offer; a new offer
 * (another "gen") replaces the whole connection, which is also how a failed one is rebuilt.
 */

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";
export type LinkState = "connecting" | "connected" | "failed";

export interface WatchedStream {
  stream: MediaStream; // video + optional stream audio
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Connection quality to one person in the call (statistics panel). */
export interface PeerStats {
  userId: string;
  state: LinkState;
  /** local: same network · direct: straight over the internet · relay: through the TURN server. */
  path: "local" | "direct" | "relay" | null;
  protocol: string | null;
  /** Round trip to this person in ms. */
  rttMs: number | null;
  /** Share of their packets that never arrived since the last sample, in percent. */
  lossPct: number | null;
  jitterMs: number | null;
  upKbps: number | null;
  downKbps: number | null;
  /** Video I receive from / send to them right now ("H264 1080p60"); null while none flows. */
  videoIn: string | null;
  videoOut: string | null;
}

export interface ShareOptions {
  preset: StreamPreset;
  /** Desktop: desktopCapturer source id. Web: the browser's own picker. */
  sourceId?: string;
  sourceSize?: { width: number; height: number; refreshRate: number | null };
  contentHint: "motion" | "detail";
  audio: boolean;
  /** Video bitrate limit per viewer in bit/s; absent = the preset's own. */
  bitrate?: number;
  /** Tests only: a ready-made video track instead of a capture. */
  testTrack?: MediaStreamTrack;
  /** Test only: stream audio instead of the system sound. */
  testAudio?: MediaStreamTrack;
}

interface VoiceUi {
  status: VoiceStatus;
  guildId: string | null;
  channelId: string | null;
  muted: boolean;
  deafened: boolean;
  /** Local VAD / push-to-talk: am I transmitting right now? */
  selfSpeaking: boolean;
  micLevel: number; // dBFS, for the settings meter
  micError: string | null;
  sharing: { width: number; height: number; fps: number; audio: boolean; preset: StreamPreset; codec?: string } | null;
  watching: Record<string, WatchedStream | null>; // userId -> stream (null while connecting)
  focus: string | null;
  /** My camera, while it is on. */
  camera: { facing: "user" | "environment"; canFlip: boolean } | null;
  /** Other people's cameras (userId -> video). */
  cams: Record<string, MediaStream>;
  /** Direct connection to each other person in the channel. */
  links: Record<string, LinkState>;
}

export const useVoice = create<VoiceUi>()(() => ({
  status: "idle",
  guildId: null,
  channelId: null,
  muted: false,
  deafened: false,
  selfSpeaking: false,
  micLevel: -100,
  micError: null,
  sharing: null,
  watching: {},
  focus: null,
  camera: null,
  cams: {},
  links: {},
}));

const setV = (p: Partial<VoiceUi> | ((s: VoiceUi) => Partial<VoiceUi>)) => useVoice.setState(p);

/**
 * Connection quality while in a call, sampled every 2 s (its own store: it changes far more often
 * than the call state). `ping` is the average round trip to the people in the call, null while alone.
 */
export const useCallStats = create<{ peers: PeerStats[]; ping: number | null }>()(() => ({ peers: [], ping: null }));
const STATS_MS = 2000;

const MIC = 0, CAM = 1, SCREEN = 2, SCREEN_AUDIO = 3;
const KINDS = ["audio", "video", "video", "audio"] as const;

interface Link {
  userId: string;
  offerer: boolean;
  gen: number;
  pc: RTCPeerConnection;
  /** [mic, camera, screen, screen audio] once known (offerer: at once; answerer: after the offer). */
  tx: RTCRtpTransceiver[];
  /** Remote description set: candidates can be added. */
  ready: boolean;
  pending: RTCIceCandidateInit[];
  /** My candidates found before my offer went out (the other side must get the offer first). */
  outbox: RTCIceCandidateInit[] | null;
  audioEl: HTMLAudioElement | null;
  sendsScreen: boolean;
  lostTimer: ReturnType<typeof setTimeout> | null;
}

type Signal = Events["rtc.signal"];

class VoiceEngine {
  private conn: HostConnection | null = null;
  private offConn: (() => void) | null = null;
  private seq = 0;
  private errRejoinAt = 0;

  /** voice.join answered: links can be made. Signals that arrive earlier wait in `early`. */
  private joined = false;
  private early: Signal[] = [];
  private iceServers: IceServer[] = [];
  private myState: VoiceState | null = null;
  /** Everyone else in my channel. */
  private states = new Map<string, VoiceState>();
  private links = new Map<string, Link>();
  /** Counters of the previous statistics sample per person (rates are differences). */
  private statPrev = new Map<string, { gen: number; at: number; sent: number; recv: number; lost: number; got: number }>();
  private retries = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private micStream: MediaStream | null = null;
  private micSendTrack: MediaStreamTrack | null = null;
  private micMeter: LevelMeter | null = null;
  private denoised: Denoised | null = null;
  private gate = new VadGate();
  private pttDown = false;
  private offPtt: (() => void) | null = null;
  private offHotkeys: (() => void) | null = null;

  private screenStream: MediaStream | null = null;
  private sysAudio: PcmTrack | null = null;
  private shareOpts: ShareOptions | null = null;
  /** Codecs I want to send my screen with, best first (decided when the share starts). */
  private shareCodecs: string[] = [];
  private shareHealth: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  private camStream: MediaStream | null = null;
  private camFacing: "user" | "environment" = "user";

  // ---------- lifecycle ----------

  /** Join a voice channel. Call directly from a click handler (iOS needs the gesture). */
  async join(guildId: string, channelId: string): Promise<void> {
    const conn = useStore.getState().conn;
    if (!conn) return;
    audioContext(); // unlock audio inside the gesture
    micContext();
    const micPromise = this.openMic(); // getUserMedia before the first await (iOS)
    // Phones: keep the call alive in the background (silent media loop must start inside the tap).
    const chName = useStore.getState().guilds[guildId]?.channels.find((c) => c.id === channelId)?.name ?? "NooXCord";
    startBackgroundCall(chName, {
      hangup: () => void this.leave(),
      toggleMic: () => void this.setMuted(!useVoice.getState().muted),
      fixMic: () => void this.repairMic(),
      refreshVideo: () => void this.rewatchAll(),
    });
    const seq = ++this.seq;
    if (useVoice.getState().channelId) await this.teardown(true);
    setV({ status: "connecting", guildId, channelId, watching: {}, focus: null, sharing: null, links: {} });
    this.bindConn(conn);
    try {
      await this.connect(conn, channelId, seq);
      await micPromise;
      if (seq !== this.seq) return;
      this.applyMic();
    } catch (e) {
      if (seq !== this.seq) return;
      await this.teardown(true);
      useStore.getState().toast((e as Error).message || t("err.voiceJoin"), "error");
    }
  }

  async leave(): Promise<void> {
    this.seq++;
    await this.teardown(true);
  }

  private bindConn(conn: HostConnection) {
    if (this.conn === conn) return;
    this.offConn?.();
    this.conn = conn;
    this.offConn = conn.on(<E extends EventName>(e: E, d: Events[E]) => this.onEvent(e, d));
    remote.bind(conn);
  }

  /** Joins on the host, then connects to everyone already there. */
  private async connect(conn: HostConnection, channelId: string, seq: number): Promise<void> {
    const { muted, deafened } = useVoice.getState();
    this.joined = false;
    this.early = [];
    const res = await conn.call("voice.join", { channelId, muted, deafened });
    if (seq !== this.seq) {
      conn.call("voice.leave", {}).catch(() => {});
      return;
    }
    this.iceServers = res.iceServers;
    this.myState = res.state;
    this.states.clear();
    for (const p of res.peers) this.states.set(p.userId, p);
    this.joined = true;
    setV({ status: "connected", links: Object.fromEntries(res.peers.map((p) => [p.userId, "connecting" as LinkState])) });
    platform.media?.setInCall(true).catch(() => {});
    this.startStats();
    for (const p of res.peers) this.meet(p.userId);
    const early = this.early;
    this.early = [];
    for (const d of early) void this.onSignal(d);
  }

  /** Close everything local; tell the server unless the session is already gone. */
  private async teardown(notifyServer: boolean): Promise<void> {
    const wasIn = !!useVoice.getState().channelId;
    if (notifyServer && wasIn) await this.conn?.call("voice.leave", {}).catch(() => {});
    this.closeLinks();
    this.stopStats();
    this.stopScreenLocal();
    this.stopCameraLocal();
    this.closeMic();
    this.myState = null;
    // Out of voice for good (not a channel switch): the mic context's audio thread can sleep.
    setTimeout(() => {
      if (useVoice.getState().channelId) return;
      if (!this.micStream) idleMicContext();
      stopBackgroundCall();
    }, 1000);
    setV({ status: "idle", guildId: null, channelId: null, watching: {}, focus: null, sharing: null, selfSpeaking: false, camera: null, cams: {}, links: {} });
    platform.media?.setInCall(false).catch(() => {});
  }

  private closeLinks() {
    for (const id of [...this.links.keys()]) this.closeLink(id);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retries.clear();
    this.states.clear();
    this.joined = false;
    this.early = [];
  }

  // ---------- server events ----------

  private onEvent<E extends EventName>(e: E, raw: Events[E]): void {
    const v = useVoice.getState();
    switch (e) {
      case "ready": {
        // Socket reconnected: the old session died with the old socket. Rejoin.
        if (v.channelId && v.guildId) void this.rejoin(v.channelId);
        break;
      }
      case "voice.ended": {
        if (!v.channelId) break;
        const { reason } = raw as Events["voice.ended"];
        if (reason === "error" && Date.now() - this.errRejoinAt > 10_000) {
          this.errRejoinAt = Date.now();
          void this.rejoin(v.channelId);
          break;
        }
        this.seq++;
        void this.teardown(false);
        useStore.getState().toast(reason === "replaced" ? t("err.voiceReplaced") : t("err.voiceRemoved"), "info");
        break;
      }
      case "rtc.signal": {
        if (v.channelId) void this.onSignal(raw as Signal);
        break;
      }
      case "voice.state": {
        const s = raw as Events["voice.state"];
        if (!v.channelId || !this.joined) break;
        if (s.userId === useStore.getState().me?.id) {
          if (s.channelId !== v.channelId) break;
          this.myState = s;
          this.syncScreenSenders();
          break;
        }
        if (s.channelId !== v.channelId) {
          if (this.states.has(s.userId)) this.dropPeer(s.userId); // moved to another channel
          break;
        }
        const old = this.states.get(s.userId);
        this.states.set(s.userId, s);
        if (!old || old.joinedAt !== s.joinedAt) {
          // Joined (or rejoined after a dropped socket): a fresh connection.
          setV((x) => ({ links: { ...x.links, [s.userId]: "connecting" } }));
          this.meet(s.userId, true);
          break;
        }
        this.syncCam(s.userId);
        this.applyDeafen();
        if (s.userId in v.watching) {
          if (!s.stream) this.forgetWatch(s.userId); // the stream I watched ended
          else this.refreshWatch(s.userId);
        }
        break;
      }
      case "voice.leave": {
        const d = raw as Events["voice.leave"];
        if (this.states.has(d.userId)) this.dropPeer(d.userId);
        break;
      }
    }
  }

  private async rejoin(channelId: string) {
    const conn = this.conn;
    if (!conn) return;
    const watching = Object.keys(useVoice.getState().watching);
    const share = this.screenStream && this.shareOpts ? this.shareOpts : null;
    const cam = !!this.camStream;
    const seq = ++this.seq;
    setV({ status: "reconnecting" });
    this.closeLinks();
    try {
      await this.connect(conn, channelId, seq);
      if (seq !== this.seq) return;
      this.applyMic();
      if (share) await this.announceStream(share.preset).catch(() => this.stopScreenLocal());
      if (cam) await conn.call("voice.update", { camera: true }).catch(() => this.stopCameraLocal());
      for (const uid of watching) await this.watch(uid).catch(() => this.forgetWatch(uid));
    } catch {
      if (seq === this.seq) {
        await this.teardown(false);
        useStore.getState().toast(t("err.voiceRejoin"), "error");
      }
    }
  }

  // ---------- peer connections ----------

  private isOfferer(userId: string): boolean {
    const me = useStore.getState().me?.id ?? "";
    return me < userId;
  }

  /** Someone is (newly) in the channel with me: the offerer connects, the other side waits for the offer. */
  private meet(userId: string, fresh = false) {
    if (this.isOfferer(userId)) void this.offer(userId);
    else if (fresh) this.closeLink(userId); // their old connection died with their old session
  }

  private makeLink(userId: string, offerer: boolean, gen: number): Link {
    this.closeLink(userId);
    // "Hide my IP": only relayed candidates, so the other side sees the TURN server's address, never mine.
    // Without a TURN server on the host nothing could connect that way, so the setting waits for one.
    const relay = voiceSettings().relayOnly && this.hasRelay();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[], bundlePolicy: "max-bundle", iceTransportPolicy: relay ? "relay" : "all" });
    const link: Link = { userId, offerer, gen, pc, tx: [], ready: false, pending: [], outbox: offerer ? [] : null, audioEl: null, sendsScreen: false, lostTimer: null };
    pc.onicecandidate = (e) => {
      if (this.links.get(userId) !== link || !e.candidate) return;
      const c: RTCIceCandidateInit = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
      if (link.outbox) link.outbox.push(c);
      else this.signal(userId, gen, { candidate: c });
    };
    pc.onconnectionstatechange = () => this.onLinkState(link);
    this.links.set(userId, link);
    if (offerer) {
      for (const kind of KINDS) pc.addTransceiver(kind, { direction: "sendrecv" });
      link.tx = pc.getTransceivers();
      this.prepare(link);
    }
    return link;
  }

  /** Did the host hand out a TURN relay for this call? */
  hasRelay(): boolean {
    return this.iceServers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
  }

  private closeLink(userId: string) {
    const link = this.links.get(userId);
    if (!link) return;
    this.links.delete(userId);
    this.statPrev.delete(userId);
    if (link.lostTimer) clearTimeout(link.lostTimer);
    if (link.audioEl) {
      link.audioEl.pause();
      link.audioEl.srcObject = null;
    }
    link.pc.onicecandidate = null;
    link.pc.onconnectionstatechange = null;
    link.pc.close();
  }

  /** Someone left the channel. */
  private dropPeer(userId: string) {
    this.states.delete(userId);
    this.closeLink(userId);
    const timer = this.retryTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(userId);
    this.retries.delete(userId);
    if (userId in useVoice.getState().watching) this.forgetWatch(userId);
    setV((s) => {
      const cams = { ...s.cams };
      const links = { ...s.links };
      delete cams[userId];
      delete links[userId];
      return { cams, links };
    });
  }

  private signal(to: string, gen: number, d: { description?: { type: "offer" | "answer"; sdp: string }; candidate?: RTCIceCandidateInit | null }) {
    this.conn?.call("rtc.signal", { to, gen, ...d } as never).catch((e: Error) => console.warn("[voice] signal failed", e.message));
  }

  private async offer(userId: string): Promise<void> {
    const timer = this.retryTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(userId);
    const gen = Math.floor(Math.random() * 1e9);
    const link = this.makeLink(userId, true, gen);
    try {
      const offer = await link.pc.createOffer();
      if (this.links.get(userId) !== link) return;
      const sdp = tuneOpus(offer.sdp ?? "");
      await link.pc.setLocalDescription({ type: "offer", sdp });
      this.signal(userId, gen, { description: { type: "offer", sdp } });
      const early = link.outbox ?? [];
      link.outbox = null;
      for (const c of early) this.signal(userId, gen, { candidate: c });
    } catch (e) {
      console.warn("[voice] offer failed", e);
      this.linkFailed(link);
    }
  }

  private async onSignal(d: Signal): Promise<void> {
    if (!this.joined) {
      this.early.push(d);
      return;
    }
    let link = this.links.get(d.from);
    try {
      if (d.description?.type === "offer") {
        if (link && link.gen === d.gen) return; // already handled
        link = this.makeLink(d.from, false, d.gen);
        await link.pc.setRemoteDescription(d.description);
        if (this.links.get(d.from) !== link) return;
        link.tx = link.pc.getTransceivers();
        this.prepare(link);
        await this.flushCandidates(link);
        const answer = await link.pc.createAnswer();
        if (this.links.get(d.from) !== link) return;
        const sdp = tuneOpus(answer.sdp ?? "");
        await link.pc.setLocalDescription({ type: "answer", sdp });
        this.signal(d.from, d.gen, { description: { type: "answer", sdp } });
        this.tune(link);
        return;
      }
      if (!link || link.gen !== d.gen) return; // an older connection's leftovers
      if (d.description?.type === "answer") {
        if (!link.offerer || link.ready) return;
        await link.pc.setRemoteDescription(d.description);
        await this.flushCandidates(link);
        this.tune(link);
        return;
      }
      if (d.candidate) {
        if (link.ready) await link.pc.addIceCandidate(d.candidate).catch(() => {});
        else link.pending.push(d.candidate);
      }
    } catch (e) {
      console.warn("[voice] signalling with", d.from, "failed", e);
      if (link && this.links.get(d.from) === link) this.linkFailed(link);
    }
  }

  private async flushCandidates(link: Link) {
    link.ready = true;
    const list = link.pending;
    link.pending = [];
    for (const c of list) await link.pc.addIceCandidate(c).catch(() => {});
  }

  /** Transceivers known: directions, codecs, my current tracks, and playback of theirs. */
  private prepare(link: Link) {
    const [mic, cam, screen, screenAudio] = link.tx;
    if (!mic || !cam || !screen || !screenAudio) return;
    for (const tr of link.tx) tr.direction = "sendrecv";
    prefer(cam, ["video/h264", "video/vp8"]);
    prefer(screen, screenCodecOrder(voiceSettings().streamCodec));
    void mic.sender.replaceTrack(this.micSendTrack).catch(() => {});
    void cam.sender.replaceTrack(this.camStream?.getVideoTracks()[0] ?? null).catch(() => {});
    link.sendsScreen = false;
    this.syncScreenSenders();
    // Their side: voice, camera, the stream when I watch it.
    holdJitter(mic.receiver, 80);
    holdJitter(screenAudio.receiver, 120);
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = new MediaStream([mic.receiver.track]);
    el.volume = Math.min(1, voiceSettings().volumes[link.userId] ?? 1);
    const sink = voiceSettings().outputDeviceId;
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sink && withSink.setSinkId) void withSink.setSinkId(sink).catch(() => {});
    link.audioEl = el;
    this.applyDeafen();
    void el.play().catch(() => {});
    this.syncCam(link.userId);
    if (link.userId in useVoice.getState().watching) this.refreshWatch(link.userId);
  }

  /** Sending limits once negotiated (the encodings exist only then). */
  private tune(link: Link) {
    const [mic, cam, screen, screenAudio] = link.tx;
    // Voice first when the uplink is busy (a stream or a game download).
    void setEncoding(mic?.sender, { priority: "high", networkPriority: "high" });
    void setEncoding(cam?.sender, { maxBitrate: 600_000, maxFramerate: 24 });
    void setEncoding(screenAudio?.sender, { priority: "high", networkPriority: "high", maxBitrate: 128_000 });
    if (link.sendsScreen) void this.tuneScreen(screen?.sender);
  }

  private async tuneScreen(sender: RTCRtpSender | undefined) {
    const opts = this.shareOpts;
    if (!sender || !opts) return;
    const enc = { maxBitrate: opts.bitrate ?? STREAM_PRESETS[opts.preset].bitrate, maxFramerate: this.sharingFps() };
    const degradation = opts.contentHint === "detail" ? "maintain-resolution" : "maintain-framerate";
    // The codec is the streamer's choice among what this viewer negotiated (without this the first
    // codec of the viewer's description is used, i.e. the viewer's own preference).
    const codec = negotiatedCodec(sender, this.shareCodecs);
    if (codec && (await setEncoding(sender, { ...enc, codec }, degradation))) return;
    await setEncoding(sender, enc, degradation);
  }

  private sharingFps(): number {
    const opts = this.shareOpts;
    if (!opts) return 30;
    const preset = STREAM_PRESETS[opts.preset];
    return opts.preset === "source" ? Math.min(opts.sourceSize?.refreshRate ?? 60, 120) : preset.fps;
  }

  private onLinkState(link: Link) {
    if (this.links.get(link.userId) !== link) return;
    const st = link.pc.connectionState;
    const ui: LinkState = st === "connected" ? "connected" : st === "failed" ? "failed" : "connecting";
    if (useVoice.getState().links[link.userId] !== ui) setV((s) => ({ links: { ...s.links, [link.userId]: ui } }));
    if (link.lostTimer) clearTimeout(link.lostTimer);
    link.lostTimer = null;
    if (st === "connected") {
      this.retries.delete(link.userId);
      console.info(`[voice] connected to ${nameOf(link.userId)}`);
    } else if (st === "disconnected") {
      // Often comes back by itself (a Wi-Fi hiccup); if not, rebuild.
      link.lostTimer = setTimeout(() => { if (link.pc.connectionState !== "connected") this.linkFailed(link); }, 8000);
    } else if (st === "failed") this.linkFailed(link);
  }

  /** The connection is dead. The offerer builds a new one (backing off); the other side waits for it. */
  private linkFailed(link: Link) {
    if (this.links.get(link.userId) !== link) return;
    setV((s) => ({ links: { ...s.links, [link.userId]: "failed" } }));
    if (!link.offerer) return;
    const n = this.retries.get(link.userId) ?? 0;
    this.retries.set(link.userId, n + 1);
    if (n === 1) useStore.getState().toast(t("err.voicePeerFailed", { name: nameOf(link.userId) }), "error");
    const timer = setTimeout(() => {
      this.retryTimers.delete(link.userId);
      if (this.links.get(link.userId) === link && this.states.has(link.userId)) void this.offer(link.userId);
    }, Math.min(30_000, 1000 * 3 ** n));
    this.retryTimers.set(link.userId, timer);
  }

  // ---------- microphone ----------

  private async openMic(): Promise<void> {
    if (this.micStream) return;
    const s = voiceSettings();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: s.inputDeviceId ? { exact: s.inputDeviceId } : undefined,
          echoCancellation: s.echoCancellation,
          // Our own model replaces the browser's suppressor (both at once smear speech).
          noiseSuppression: s.noiseMode === "browser",
          autoGainControl: s.autoGainControl,
          channelCount: 1,
        },
      });
      setV({ micError: null });
    } catch (e) {
      const name = (e as DOMException).name;
      // Browsers give no microphone on plain http:// (only https or localhost).
      const msg = !window.isSecureContext ? t("err.micInsecure") : name === "NotAllowedError" ? t("err.micDenied") : name === "NotFoundError" ? t("err.micMissing") : t("err.micFailed");
      setV({ micError: msg });
      useStore.getState().toast(msg, "error");
      return;
    }
    let track = this.micStream.getAudioTracks()[0]!;
    const stream = this.micStream;
    if (!s.inputDeviceId) void defaultMicSig().then((sig) => { if (this.micStream === stream) this.micDefaultSig = sig; });
    this.denoised = await denoise(track, s.noiseMode).catch((e: unknown) => {
      console.warn("[voice] noise suppression unavailable", e);
      return null;
    });
    if (this.micStream !== stream) { this.denoised?.stop(); this.denoised = null; return; } // closed meanwhile
    if (this.denoised) track = this.denoised.track; // the gate also hears the cleaned sound: fewer false opens
    // The senders get a clone so the gate can silence it while the meter still hears the original.
    this.micSendTrack = track.clone();
    this.micSendTrack.enabled = false;
    this.micMeter = await meter(track, (db) => this.onMicLevel(db), (n) => this.onMicHoles(n)).catch(() => null);
    this.watchPtt();
    this.watchHotkeys();
  }

  /** The (new) microphone track on every connection. */
  private applyMic() {
    for (const link of this.links.values()) void link.tx[MIC]?.sender.replaceTrack(this.micSendTrack).catch(() => {});
  }

  /**
   * Self-healing for crackling microphone audio: once the capture path starts dropping blocks it
   * rarely recovers by itself, but re-opening the microphone fixes it (users did this by switching the
   * noise mode back and forth). Many dropouts within 10 s -> rebuild, at most every 30 s.
   */
  private holeTimes: number[] = [];
  private healedAt = 0;
  private onMicHoles(n: number) {
    const now = performance.now();
    for (let i = 0; i < n; i++) this.holeTimes.push(now);
    this.holeTimes = this.holeTimes.filter((x) => now - x < 10_000);
    if (this.holeTimes.length < 15 || now - this.healedAt < 30_000) return;
    this.healedAt = now;
    this.holeTimes = [];
    console.warn("[voice] microphone audio is dropping out, re-opening the microphone");
    void this.restartMic();
  }

  private closeMic() {
    this.micMeter?.stop();
    this.micMeter = null;
    this.denoised?.stop();
    this.denoised = null;
    this.micStream?.getTracks().forEach((x) => x.stop());
    this.micSendTrack?.stop();
    this.micStream = null;
    this.micSendTrack = null;
    this.offPtt?.();
    this.offPtt = null;
    this.pttDown = false;
    this.offHotkeys?.();
    this.offHotkeys = null;
  }

  private onMicLevel(db: number) {
    const s = voiceSettings();
    const v = useVoice.getState();
    const open = s.mode === "ptt" ? this.pttDown : this.gate.update(db, s.vadThreshold);
    const speaking = open && !v.muted && !v.deafened && v.status === "connected" && !!this.micSendTrack && !this.myState?.suppressed;
    if (this.micSendTrack) this.micSendTrack.enabled = speaking;
    if (speaking !== v.selfSpeaking) {
      setV({ selfSpeaking: speaking });
      // Everyone else's speaking ring comes from this report (the hang time keeps it to a few per second).
      if (v.status === "connected") this.conn?.call("voice.speaking", { speaking }).catch(() => {});
    }
    if (Math.abs(db - v.micLevel) > 1.5) setV({ micLevel: db });
  }

  /** Effective VAD threshold (for the settings meter). */
  vadThreshold(): number {
    return voiceSettings().vadThreshold ?? this.gate.autoThreshold;
  }

  /** Mute toggle shortcut: global on desktop (main-process key polling), window keys on the web. */
  private watchHotkeys() {
    this.offHotkeys?.();
    const typing = () => {
      const a = document.activeElement;
      return document.hasFocus() && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a instanceof HTMLElement && a.isContentEditable));
    };
    const fire = (id: string) => {
      const combo = voiceSettings().muteKey;
      if (id !== "mute" || !combo) return;
      // A plain key typed into the chat box is text, not a shortcut.
      if (typing() && !/^(Ctrl|Alt)\+/.test(combo) && !/^(F\d+|Mouse\d)$/.test(combo)) return;
      void this.setMuted(!useVoice.getState().muted);
    };
    const sync = () => {
      const k = voiceSettings().muteKey;
      void platform.media?.setHotkeys(k ? [{ id: "mute", combo: k }] : []);
    };
    let offGlobal: (() => void) | undefined;
    let keydown: ((e: KeyboardEvent) => void) | undefined;
    if (platform.media) {
      sync();
      offGlobal = platform.media.onHotkey(fire);
    } else {
      keydown = (e: KeyboardEvent) => { if (!e.repeat && comboOf(e) === voiceSettings().muteKey) fire("mute"); };
      window.addEventListener("keydown", keydown);
    }
    const offSettings = useVoiceSettings.subscribe((st, prev) => { if (st.muteKey !== prev.muteKey) sync(); });
    this.offHotkeys = () => {
      offSettings();
      offGlobal?.();
      if (keydown) window.removeEventListener("keydown", keydown);
      void platform.media?.setHotkeys([]);
    };
  }

  private watchPtt() {
    this.offPtt?.();
    const keydown = (e: KeyboardEvent) => {
      if (e.code === voiceSettings().pttKey && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) this.pttDown = true;
    };
    const keyup = (e: KeyboardEvent) => { if (e.code === voiceSettings().pttKey) this.pttDown = false; };
    const blur = () => { if (!platform.media) this.pttDown = false; };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    // Desktop: global key watch in the main process (works while a game has focus).
    const syncGlobal = () => {
      const st = voiceSettings();
      void platform.media?.setPttKey(st.mode === "ptt" ? st.pttKey : null);
    };
    syncGlobal();
    const offSettings = useVoiceSettings.subscribe((st, prev) => { if (st.mode !== prev.mode || st.pttKey !== prev.pttKey) syncGlobal(); });
    const offGlobal = platform.media?.onPtt((down) => (this.pttDown = down));
    this.offPtt = () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      offSettings();
      offGlobal?.();
      void platform.media?.setPttKey(null);
    };
  }

  async setMuted(muted: boolean): Promise<void> {
    const v = useVoice.getState();
    // Unmuting while deafened also undeafens (as people expect).
    const deafened = !muted && v.deafened ? false : v.deafened;
    setV({ muted, deafened });
    this.applyDeafen();
    if (this.micSendTrack && (muted || deafened)) this.micSendTrack.enabled = false;
    if (!v.channelId) return;
    await this.conn?.call("voice.update", { muted, deafened }).catch(() => {});
  }

  async setDeafened(deafened: boolean): Promise<void> {
    const v = useVoice.getState();
    setV({ deafened });
    this.applyDeafen();
    if (this.micSendTrack && deafened) this.micSendTrack.enabled = false;
    if (!v.channelId) return;
    await this.conn?.call("voice.update", { deafened }).catch(() => {});
  }

  /** Which physical device "default" was when the microphone opened. */
  private micDefaultSig = "";
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A microphone was plugged in / out or Windows' default changed. Chromium keeps a "default" capture on
   * the device it first opened, so with "system default" selected we reopen the microphone ourselves.
   */
  onDevicesChanged(): void {
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    this.deviceTimer = setTimeout(() => void this.followDefaultMic(), 700); // devices arrive in bursts
  }

  private async followDefaultMic(): Promise<void> {
    const stream = this.micStream;
    if (!useVoice.getState().channelId || !stream || voiceSettings().inputDeviceId) return;
    const sig = await defaultMicSig();
    const live = stream.getAudioTracks()[0]?.readyState === "live";
    if (!sig || this.micStream !== stream || (live && sig === this.micDefaultSig)) return;
    console.info(`[voice] default microphone changed (${this.micDefaultSig} -> ${sig}), reopening`);
    await this.restartMic();
    const name = sig.slice(sig.indexOf("|") + 1).replace(/^(Varsayılan|Default)\s*-\s*/i, "");
    if (this.micStream && name) useStore.getState().toast(t("voice.micChanged", { name }), "info");
  }

  /** iOS ends the microphone track while the page is in the background: reopen it on return. */
  async repairMic(): Promise<void> {
    const track = this.micStream?.getAudioTracks()[0];
    if (!useVoice.getState().channelId || !track || track.readyState === "live") return;
    await this.restartMic();
  }

  /** Re-open the microphone after a device/processing change. */
  async restartMic(): Promise<void> {
    if (!useVoice.getState().channelId) return;
    this.closeMic();
    await this.openMic();
    this.applyMic();
  }

  // ---------- playback ----------

  /** Deafened: nobody. People the server muted (no SPEAK permission) stay silent too. */
  private applyDeafen() {
    const { deafened } = useVoice.getState();
    for (const link of this.links.values()) {
      if (link.audioEl) link.audioEl.muted = deafened || !!this.states.get(link.userId)?.suppressed;
    }
  }

  setUserVolume(userId: string, volume: number) {
    useVoiceSettings.getState().set({ volumes: { ...voiceSettings().volumes, [userId]: volume } });
    const el = this.links.get(userId)?.audioEl;
    if (el) el.volume = Math.min(1, volume);
  }

  async setOutputDevice(id: string) {
    for (const link of this.links.values()) {
      const el = link.audioEl as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
      await el?.setSinkId?.(id).catch(() => {});
    }
  }

  // ---------- watching streams ----------

  async watch(userId: string): Promise<void> {
    const conn = this.conn;
    if (!conn || !useVoice.getState().channelId) return;
    // First stream: it fills the stage. Another one: side by side (no focus) until one is clicked.
    setV((s) => ({ watching: { ...s.watching, [userId]: s.watching[userId] ?? null }, focus: Object.keys(s.watching).some((id) => id !== userId) ? null : userId }));
    try {
      await conn.call("stream.watch", { userId, watching: true });
      this.refreshWatch(userId);
    } catch (e) {
      this.forgetWatch(userId);
      useStore.getState().toast((e as Error).message, "error");
    }
  }

  async unwatch(userId: string): Promise<void> {
    this.forgetWatch(userId);
    await this.conn?.call("stream.watch", { userId, watching: false }).catch(() => {});
  }

  /** Re-subscribe every watched stream (iPhone: decoding froze while the page was in the background). */
  async rewatchAll(): Promise<void> {
    const v = useVoice.getState();
    const ids = Object.keys(v.watching);
    if (!ids.length || v.status !== "connected") return;
    const focus = v.focus;
    for (const id of ids) {
      await this.unwatch(id);
      await this.watch(id);
    }
    if (focus && focus in useVoice.getState().watching) this.setFocus(focus);
  }

  /** The watched stream's tracks from the current connection to that person (null while there is none). */
  private refreshWatch(userId: string) {
    const v = useVoice.getState();
    if (!(userId in v.watching)) return;
    const link = this.links.get(userId);
    const video = link?.tx[SCREEN]?.receiver.track;
    const audio = link?.tx[SCREEN_AUDIO]?.receiver.track;
    if (!video || !audio) {
      if (v.watching[userId]) setV((s) => ({ watching: { ...s.watching, [userId]: null } }));
      return;
    }
    const hasAudio = !!this.states.get(userId)?.stream?.audio;
    const cur = v.watching[userId];
    const tracks = cur?.stream.getTracks() ?? [];
    if (cur && tracks.includes(video) && cur.hasAudio === hasAudio && (!hasAudio || tracks.includes(audio))) return;
    const stream = new MediaStream(hasAudio ? [video, audio] : [video]);
    setV((s) => ({ watching: { ...s.watching, [userId]: { stream, hasVideo: true, hasAudio } } }));
  }

  private forgetWatch(userId: string) {
    setV((s) => {
      const watching = { ...s.watching };
      delete watching[userId];
      return { watching, focus: s.focus === userId ? Object.keys(watching)[0] ?? null : s.focus };
    });
  }

  setFocus(userId: string | null) {
    setV({ focus: userId });
  }

  // ---------- camera ----------

  /** Their camera tile follows their VoiceState.camera (the receiving track always exists). */
  private syncCam(userId: string) {
    const track = this.links.get(userId)?.tx[CAM]?.receiver.track;
    const on = !!this.states.get(userId)?.camera && !!track;
    const cur = useVoice.getState().cams[userId];
    if (on && cur?.getVideoTracks()[0] === track) return;
    if (!on && !cur) return;
    setV((s) => {
      const cams = { ...s.cams };
      if (on) cams[userId] = new MediaStream([track!]);
      else delete cams[userId];
      return { cams };
    });
  }

  private applyCam() {
    const track = this.camStream?.getVideoTracks()[0] ?? null;
    for (const link of this.links.values()) void link.tx[CAM]?.sender.replaceTrack(track).catch(() => {});
  }

  /** Opens the camera. Call straight from a click (iOS wants getUserMedia inside the gesture). */
  async startCamera(): Promise<void> {
    const v = useVoice.getState();
    if (!v.channelId || v.camera || this.camStream || !this.conn) return;
    const stream = await this.openCamera(this.camFacing, true);
    if (!useVoice.getState().channelId) { stream.getTracks().forEach((x) => x.stop()); return; }
    this.camStream = stream;
    const track = stream.getVideoTracks()[0]!;
    track.contentHint = "motion";
    track.addEventListener("ended", () => { if (this.camStream === stream) void this.stopCamera(); });
    this.applyCam();
    try {
      await this.conn.call("voice.update", { camera: true });
    } catch (e) {
      this.stopCameraLocal();
      throw e;
    }
    const cams = await navigator.mediaDevices.enumerateDevices().then((d) => d.filter((x) => x.kind === "videoinput").length).catch(() => 1);
    if (this.camStream === stream) setV({ camera: { facing: this.camFacing, canFlip: cams > 1 } });
  }

  private openCamera(facing: "user" | "environment", useDevice: boolean): Promise<MediaStream> {
    const id = useDevice ? voiceSettings().cameraDeviceId : "";
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: facing } }),
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 },
      },
    }).catch((e: DOMException) => {
      const msg = e.name === "NotAllowedError" ? t("err.camDenied") : e.name === "NotFoundError" || e.name === "OverconstrainedError" ? t("err.camMissing")
        : e.name === "NotReadableError" ? t("err.camBusy") : t("err.camFailed");
      throw new Error(msg);
    });
  }

  async stopCamera(): Promise<void> {
    const had = !!this.camStream;
    this.stopCameraLocal();
    if (had) await this.conn?.call("voice.update", { camera: false }).catch(() => {});
  }

  private stopCameraLocal() {
    this.camStream?.getTracks().forEach((x) => x.stop());
    this.camStream = null;
    this.applyCam();
    if (useVoice.getState().camera) setV({ camera: null });
  }

  /** Front <-> back camera (phones). Only the track changes. */
  async flipCamera(): Promise<void> {
    const old = this.camStream;
    if (!old) return;
    const facing: "user" | "environment" = this.camFacing === "user" ? "environment" : "user";
    old.getTracks().forEach((x) => x.stop()); // many phones cannot open both cameras at once
    let stream: MediaStream;
    let got = facing;
    try {
      stream = await this.openCamera(facing, false);
    } catch (e) {
      got = this.camFacing;
      stream = await this.openCamera(got, false).catch(() => { throw e; });
      useStore.getState().toast((e as Error).message, "error");
    }
    if (this.camStream !== old) { stream.getTracks().forEach((x) => x.stop()); return; }
    const track = stream.getVideoTracks()[0]!;
    track.contentHint = "motion";
    track.addEventListener("ended", () => { if (this.camStream === stream) void this.stopCamera(); });
    this.camStream = stream;
    this.applyCam();
    this.camFacing = (track.getSettings().facingMode as "user" | "environment" | undefined) ?? got;
    setV((s) => ({ camera: s.camera ? { ...s.camera, facing: this.camFacing } : null }));
  }

  /** My own camera (for the self view). */
  localCamera(): MediaStream | null {
    return this.camStream;
  }

  // ---------- screen share ----------

  async startScreen(opts: ShareOptions): Promise<void> {
    if (!this.conn || useVoice.getState().status !== "connected") throw new Error(t("err.joinVoiceFirst"));
    const preset = STREAM_PRESETS[opts.preset];
    const width = preset.width || opts.sourceSize?.width || 1920;
    const height = preset.height || opts.sourceSize?.height || 1080;
    const fps = opts.preset === "source" ? Math.min(opts.sourceSize?.refreshRate ?? 60, 120) : preset.fps;

    let stream: MediaStream;
    if (opts.testTrack) stream = new MediaStream(opts.testAudio ? [opts.testTrack, opts.testAudio] : [opts.testTrack]);
    else {
      if (platform.media && opts.sourceId) await platform.media.selectSource(opts.sourceId);
      const webAudio = !platform.media && opts.audio;
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: width }, height: { max: height }, frameRate: { ideal: fps, max: fps } },
        audio: webAudio ? { suppressLocalAudioPlayback: false } : false,
        // Chromium hints: never offer our own tab, exclude our own audio where supported.
        ...({ selfBrowserSurface: "exclude", systemAudio: "exclude", restrictOwnAudio: true } as object),
      } as DisplayMediaStreamOptions);
    }
    this.stopScreenLocal();
    this.screenStream = stream;
    this.shareOpts = { ...opts, testTrack: undefined, testAudio: undefined };
    const video = stream.getVideoTracks()[0];
    if (!video) {
      this.stopScreenLocal();
      throw new Error(t("err.noVideo"));
    }
    video.contentHint = opts.contentHint;
    video.addEventListener("ended", () => void this.stopScreen());
    this.shareCodecs = screenSendOrder(voiceSettings().streamCodec);

    // Desktop system audio, NooXCord's own sound excluded (CLAUDE.md §6.3).
    let audioTrack = stream.getAudioTracks()[0] ?? null;
    if (!audioTrack && opts.audio && platform.media) audioTrack = await this.startSystemAudio();
    if (audioTrack && !stream.getAudioTracks().includes(audioTrack)) stream.addTrack(audioTrack);

    let codec: string;
    try {
      codec = await this.announceStream(opts.preset);
    } catch (e) {
      this.stopScreenLocal();
      throw e;
    }
    const st = video.getSettings();
    void this.sendThumbnail(video);
    this.watchShareHealth();
    setV({ sharing: { width: st.width ?? width, height: st.height ?? height, fps: Math.round(st.frameRate ?? fps), audio: !!audioTrack, preset: opts.preset, codec } });
  }

  /** Tells the host I stream; viewers then appear in my StreamInfo and get the tracks. Returns the codec. */
  private async announceStream(preset: StreamPreset): Promise<string> {
    const video = this.screenStream?.getVideoTracks()[0];
    if (!video || !this.conn) throw new Error(t("err.noVideo"));
    const st = video.getSettings();
    const codec = this.shareCodecs[0] ?? screenCodecOrder(voiceSettings().streamCodec)[0]!;
    const state = await this.conn.call("stream.start", {
      width: Math.max(1, Math.round(st.width ?? 1280)),
      height: Math.max(1, Math.round(st.height ?? 720)),
      fps: Math.max(1, Math.round(st.frameRate ?? STREAM_PRESETS[preset].fps)),
      audio: this.screenStream!.getAudioTracks().length > 0,
      codec,
    });
    this.myState = state;
    this.syncScreenSenders();
    return codec;
  }

  /** My screen goes to exactly the people watching it. */
  private syncScreenSenders() {
    const video = this.screenStream?.getVideoTracks()[0] ?? null;
    const audio = this.screenStream?.getAudioTracks()[0] ?? null;
    const viewers = this.myState?.stream?.viewers ?? [];
    for (const link of this.links.values()) {
      const want = !!video && viewers.includes(link.userId);
      if (want === link.sendsScreen) continue;
      const screen = link.tx[SCREEN], screenAudio = link.tx[SCREEN_AUDIO];
      if (!screen || !screenAudio) continue;
      link.sendsScreen = want;
      void screen.sender.replaceTrack(want ? video : null).then(() => { if (want) void this.tuneScreen(screen.sender); }).catch(() => {});
      void screenAudio.sender.replaceTrack(want ? audio : null).catch(() => {});
    }
  }

  private async startSystemAudio(): Promise<MediaStreamTrack | null> {
    const media = platform.media;
    if (!media || !(await media.systemAudioSupported().catch(() => false))) {
      useStore.getState().toast(t("err.sysAudioUnsupported"), "error");
      return null;
    }
    const portPromise = new Promise<MessagePort>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.source === window && e.data === "nx:sysaudio-port" && e.ports[0]) {
          window.removeEventListener("message", onMsg);
          resolve(e.ports[0]);
        }
      };
      window.addEventListener("message", onMsg);
    });
    const res = await media.startSystemAudio();
    if (!res.ok) {
      useStore.getState().toast(t("err.sysAudioFailed", { msg: res.error ?? "?" }), "error");
      return null;
    }
    const port = await portPromise;
    this.sysAudio = await pcmTrack(port, res.sampleRate, res.channels);
    return this.sysAudio.track;
  }

  /** One-off 480px JPEG preview (CLAUDE.md §6.4). */
  private async sendThumbnail(track: MediaStreamTrack) {
    const http = useStore.getState().http;
    if (!http) return;
    try {
      const v = document.createElement("video");
      v.muted = true;
      v.srcObject = new MediaStream([track]);
      await v.play();
      await new Promise((r) => setTimeout(r, 400));
      const w = 480;
      const h = Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(v, 0, 0, w, h);
      v.pause();
      v.srcObject = null;
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.72));
      if (blob) await http.upload("/api/stream/thumbnail", blob, "thumb.jpg").promise;
    } catch {
      /* the stream works without a preview */
    }
  }

  async stopScreen(): Promise<void> {
    const had = !!this.screenStream;
    this.stopScreenLocal();
    if (had) await this.conn?.call("stream.stop", {}).catch(() => {});
  }

  /**
   * Stream health in the desktop app's main.log while I share: capture fps, encoded fps per viewer,
   * what limits the encoder (cpu / bandwidth), key frame requests, and whether NooXCord is focused /
   * visible. A line on every change of state, otherwise once a minute.
   */
  private watchShareHealth(): void {
    if (this.shareHealth) clearInterval(this.shareHealth);
    this.shareHealth = null;
    const log = platform.media?.log;
    if (!log) return;
    const prev = new Map<string, { frames: number; at: number }>();
    let lastSig = "", lastAt = 0, busy = false;
    type Stat = {
      type: string; kind?: string; timestamp: number; framesPerSecond?: number; framesEncoded?: number;
      frameHeight?: number; qualityLimitationReason?: string; encoderImplementation?: string; pliCount?: number; firCount?: number;
    };
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        let cap = -1, maxFps = -1, pli = 0;
        const limits = new Set<string>(), parts: string[] = [];
        for (const link of this.links.values()) {
          const sender = link.tx[SCREEN]?.sender;
          if (!link.sendsScreen || !sender) continue;
          const report = await sender.getStats().catch(() => null);
          if (!report) continue;
          let layer = "-", impl = "";
          report.forEach((s: Stat) => {
            if (s.type === "media-source" && s.kind === "video") cap = Math.max(cap, Math.round(s.framesPerSecond ?? 0));
            if (s.type !== "outbound-rtp" || s.kind !== "video") return;
            const before = prev.get(link.userId);
            const frames = s.framesEncoded ?? 0;
            const fps = before && s.timestamp > before.at ? Math.round(((frames - before.frames) * 1000) / (s.timestamp - before.at)) : Math.round(s.framesPerSecond ?? 0);
            prev.set(link.userId, { frames, at: s.timestamp });
            layer = `${s.frameHeight ?? 0}p${fps}`;
            maxFps = Math.max(maxFps, fps);
            if (s.qualityLimitationReason && s.qualityLimitationReason !== "none") limits.add(s.qualityLimitationReason);
            pli += (s.pliCount ?? 0) + (s.firCount ?? 0);
            impl ||= s.encoderImplementation ?? "";
          });
          parts.push(`${nameOf(link.userId)}${impl ? `[${impl}]` : ""} ${layer}`);
        }
        if (!parts.length) return;
        const focus = document.hasFocus() ? "focus" : "nofocus";
        const vis = document.visibilityState;
        const stalled = maxFps >= 0 && maxFps < 2; // every viewer's encoder below 2 fps
        const limit = [...limits].join("+") || "none";
        const sig = `${stalled}|${limit}|${focus}|${vis}|${cap < 2}|${parts.length}`;
        const now = Date.now();
        if (sig === lastSig && now - lastAt < 60_000) return;
        lastSig = sig;
        lastAt = now;
        log(`[share] ${stalled ? "STALLED " : ""}capture ${cap}fps | ${parts.join(" | ")} | limit ${limit} | keyframe req ${pli} | ${focus} ${vis}`);
      } finally {
        busy = false;
      }
    };
    this.shareHealth = setInterval(() => void tick(), 2000);
  }

  private stopScreenLocal() {
    if (this.shareHealth) clearInterval(this.shareHealth);
    this.shareHealth = null;
    this.screenStream?.getTracks().forEach((x) => x.stop());
    this.screenStream = null;
    this.shareOpts = null;
    if (this.sysAudio) {
      this.sysAudio.stop();
      this.sysAudio = null;
      void platform.media?.stopSystemAudio();
    }
    this.syncScreenSenders();
    if (useVoice.getState().sharing) setV({ sharing: null });
  }

  /** My own outgoing screen (for the local preview tile). */
  localScreen(): MediaStream | null {
    return this.screenStream;
  }

  /** Debug/test helper: what I currently receive. */
  debugConsumers(): { userId: string; source: MediaSource; live: boolean }[] {
    const out: { userId: string; source: MediaSource; live: boolean }[] = [];
    const v = useVoice.getState();
    for (const link of this.links.values()) {
      const live = (i: number) => link.pc.connectionState === "connected" && link.tx[i]?.receiver.track.readyState === "live";
      out.push({ userId: link.userId, source: "mic", live: live(MIC) });
      if (this.states.get(link.userId)?.camera) out.push({ userId: link.userId, source: "camera", live: live(CAM) });
      if (link.userId in v.watching) {
        out.push({ userId: link.userId, source: "screen", live: live(SCREEN) });
        if (this.states.get(link.userId)?.stream?.audio) out.push({ userId: link.userId, source: "screen-audio", live: live(SCREEN_AUDIO) });
      }
    }
    return out;
  }

  /** Debug/test helper: connection state per person, and whether my screen goes to them. */
  debugLinks(): Record<string, { state: RTCPeerConnectionState; screen: boolean }> {
    return Object.fromEntries([...this.links.values()].map((l) => [l.userId, { state: l.pc.connectionState, screen: l.sendsScreen }]));
  }

  /** Keeps useCallStats current while in a call (nobody looks at it in a hidden window: skipped there). */
  private startStats() {
    this.statsTimer ??= setInterval(() => { if (document.visibilityState !== "hidden") void this.refreshStats(); }, STATS_MS);
  }

  private statsBusy = false;
  /** One sample now (the connection panel asks for it when it opens). */
  async refreshStats(): Promise<void> {
    if (this.statsBusy || !this.statsTimer) return;
    this.statsBusy = true;
    try {
      const peers = await this.peerStats();
      if (!this.statsTimer) return;
      const rtts = peers.filter((p) => p.state === "connected" && p.rttMs !== null).map((p) => p.rttMs!);
      useCallStats.setState({ peers, ping: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null });
    } finally {
      this.statsBusy = false;
    }
  }

  private stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    useCallStats.setState({ peers: [], ping: null });
  }

  /**
   * Connection quality per person, for the statistics panel: how the two of us are connected (same
   * network / direct / TURN relay), round trip, packet loss, bitrate and the video codec in use.
   * Rates are differences to the previous call, so the first sample has none.
   */
  async peerStats(): Promise<PeerStats[]> {
    const ui = useVoice.getState().links;
    const out: PeerStats[] = [];
    for (const link of [...this.links.values()]) {
      const row: PeerStats = {
        userId: link.userId, state: ui[link.userId] ?? "connecting", path: null, protocol: null, rttMs: null, lossPct: null, jitterMs: null,
        upKbps: null, downKbps: null, videoIn: null, videoOut: null,
      };
      out.push(row);
      const report = await link.pc.getStats().catch(() => null);
      if (!report || this.links.get(link.userId) !== link) continue;
      type Stat = Record<string, unknown> & { type: string; id: string };
      const byId = new Map<string, Stat>();
      report.forEach((x: Stat) => byId.set(x.id, x));
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
      const all = [...byId.values()];

      // The candidate pair in use: named by the transport; older Firefox marks it "selected" instead.
      const viaTransport = all.find((x) => x.type === "transport" && str(x.selectedCandidatePairId));
      const pair = (viaTransport && byId.get(viaTransport.selectedCandidatePairId as string))
        ?? all.find((x) => x.type === "candidate-pair" && (x.selected === true || (x.nominated === true && x.state === "succeeded")));
      let sent = 0, recv = 0;
      if (pair) {
        const local = byId.get(str(pair.localCandidateId) ?? ""), remote = byId.get(str(pair.remoteCandidateId) ?? "");
        const lt = str(local?.candidateType), rt = str(remote?.candidateType);
        if (lt && rt) row.path = lt === "relay" || rt === "relay" ? "relay" : lt === "host" && rt === "host" ? "local" : "direct";
        row.protocol = str(local?.relayProtocol) ?? str(local?.protocol);
        const rtt = num(pair.currentRoundTripTime);
        if (rtt !== null) row.rttMs = Math.max(1, Math.round(rtt * 1000));
        sent = num(pair.bytesSent) ?? 0;
        recv = num(pair.bytesReceived) ?? 0;
      }

      let lost = 0, got = 0, jitter: number | null = null;
      const video = (x: Stat): string | null => {
        const fps = Math.round(num(x.framesPerSecond) ?? 0), h = num(x.frameHeight);
        if (!fps || !h) return null; // negotiated but nothing flowing
        const codec = str(byId.get(str(x.codecId) ?? "")?.mimeType)?.replace(/^video\//i, "").toUpperCase();
        return `${codec ? `${codec} ` : ""}${h}p${fps}`;
      };
      for (const x of all) {
        if (x.type === "inbound-rtp") {
          lost += Math.max(0, num(x.packetsLost) ?? 0);
          got += num(x.packetsReceived) ?? 0;
          if (x.kind === "audio" && (num(x.packetsReceived) ?? 0) > 0) jitter = Math.max(jitter ?? 0, (num(x.jitter) ?? 0) * 1000);
          if (x.kind === "video") row.videoIn = [row.videoIn, video(x)].filter(Boolean).join(" + ") || null;
        } else if (x.type === "outbound-rtp" && x.kind === "video") {
          row.videoOut = [row.videoOut, video(x)].filter(Boolean).join(" + ") || null;
        }
      }
      if (jitter !== null) row.jitterMs = Math.round(jitter);

      const now = performance.now();
      const prev = this.statPrev.get(link.userId);
      const fresh = !prev || prev.gen !== link.gen;
      if (!fresh && now - prev.at >= 250) {
        const sec = (now - prev.at) / 1000;
        row.upKbps = Math.max(0, Math.round(((sent - prev.sent) * 8) / 1000 / sec));
        row.downKbps = Math.max(0, Math.round(((recv - prev.recv) * 8) / 1000 / sec));
        const dLost = Math.max(0, lost - prev.lost), dGot = Math.max(0, got - prev.got);
        if (dLost + dGot > 0) row.lossPct = Math.round((dLost * 1000) / (dLost + dGot)) / 10;
      }
      if (fresh || now - prev.at >= 250) this.statPrev.set(link.userId, { gen: link.gen, at: now, sent, recv, lost, got });
    }
    return out;
  }

  /** Debug/test helper: byte and frame counters over every connection. */
  async stats(): Promise<{ sendBytes: number; recvBytes: number; framesDecoded: number; audioRecvBytes: number }> {
    let sendBytes = 0, recvBytes = 0, framesDecoded = 0, audioRecvBytes = 0;
    for (const link of this.links.values()) {
      const report = await link.pc.getStats().catch(() => null);
      report?.forEach((r: { type: string; kind?: string; bytesSent?: number; bytesReceived?: number; framesDecoded?: number }) => {
        if (r.type === "outbound-rtp") sendBytes += r.bytesSent ?? 0;
        if (r.type !== "inbound-rtp") return;
        recvBytes += r.bytesReceived ?? 0;
        if (r.kind === "video") framesDecoded += r.framesDecoded ?? 0;
        else audioRecvBytes += r.bytesReceived ?? 0;
      });
    }
    return { sendBytes, recvBytes, framesDecoded, audioRecvBytes };
  }
}

export const voice = new VoiceEngine();
navigator.mediaDevices?.addEventListener?.("devicechange", () => voice.onDevicesChanged());

/** Identity of the system default microphone (its group + label); "" when unknown. */
async function defaultMicSig(): Promise<string> {
  const list = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  const inputs = list.filter((d) => d.kind === "audioinput");
  const d = inputs.find((x) => x.deviceId === "default") ?? inputs[0];
  return d ? `${d.groupId}|${d.label}` : "";
}

const nameOf = (userId: string): string => useStore.getState().users[userId]?.nickname ?? userId.slice(0, 6);

// Leave voice when the host connection goes away for good (logout / switch host).
useStore.subscribe((s, prev) => {
  if (prev.conn && !s.conn && useVoice.getState().channelId) void voice.leave();
  if (prev.conn && s.conn && prev.conn !== s.conn && useVoice.getState().channelId) void voice.leave();
});

// Dev/test hook (used by the Electron voice self-test).
(window as unknown as { __nx?: unknown }).__nx = { voice, useVoice, useCallStats, useVoiceSettings, useStore, remote, useRemote, denoise, meter };

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
/** Shortcut string of a key press ("Ctrl+Shift+KeyM"); null while only modifiers are held. */
export function comboOf(e: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.code].filter(Boolean).join("+");
}

/*
 * Minimum playout buffer for a received audio track. Over jittery paths (Wi-Fi, a TURN relay)
 * WebRTC's adaptive buffer ran near-empty and stretched / squeezed speech to catch up (robotic voice);
 * a small floor absorbs that for ~50 ms extra latency.
 */
function holdJitter(receiver: RTCRtpReceiver | undefined, ms: number): void {
  if (!receiver) return;
  const r = receiver as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    if ("jitterBufferTarget" in receiver) r.jitterBufferTarget = ms;
    else r.playoutDelayHint = ms / 1000;
  } catch { /* unsupported */ }
}

/**
 * Screen codec order. Automatic: H.265 where both graphics cards do it (measured on an RTX 5060 Ti:
 * hardware encoder and decoder; AV1 falls back to the software libaom encoder there), then H.264
 * (hardware nearly everywhere, iPhone included), then VP8. A codec picked in settings goes first.
 */
function screenCodecOrder(pref: StreamCodec): string[] {
  const common = ["video/h264", "video/vp8", "video/vp9"];
  return pref === "h264" ? common : [`video/${pref === "auto" ? "h265" : pref}`, ...common];
}

/**
 * What I send my screen with: the codec order of my setting, limited to what this machine encodes.
 * Chromium offers H.265 only with a hardware encoder, so "automatic" is H.265 on such a machine and
 * H.264 elsewhere. A viewer that did not negotiate the first codec gets the next one.
 */
function screenSendOrder(pref: StreamCodec): string[] {
  const order = screenCodecOrder(pref);
  const mine = RTCRtpSender.getCapabilities?.("video")?.codecs.map((c) => c.mimeType.toLowerCase());
  return mine ? order.filter((m) => mine.includes(m)) : order;
}

/** The first of these codecs this sender negotiated with the other side, as setParameters wants it. */
function negotiatedCodec(sender: RTCRtpSender, order: string[]): RTCRtpCodec | null {
  let codecs: RTCRtpCodecParameters[];
  try { codecs = sender.getParameters().codecs ?? []; } catch { return null; }
  for (const mime of order) {
    const c = codecs.find((x) => x.mimeType.toLowerCase() === mime);
    if (c) return { mimeType: c.mimeType, clockRate: c.clockRate, ...(c.sdpFmtpLine ? { sdpFmtpLine: c.sdpFmtpLine } : {}) };
  }
  return null;
}

/** Puts these codecs first for a video transceiver (the rest, rtx / red included, stay as fallbacks). */
function prefer(tr: RTCRtpTransceiver, order: string[]) {
  const caps = RTCRtpReceiver.getCapabilities?.("video")?.codecs;
  if (!caps || !tr.setCodecPreferences) return;
  const rank = (c: RTCRtpCodec) => {
    const i = order.indexOf(c.mimeType.toLowerCase());
    return i < 0 ? order.length : i;
  };
  try {
    tr.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
  } catch (e) {
    console.warn("[voice] codec preference refused", e);
  }
}

/** Resolves false when nothing was applied. */
async function setEncoding(sender: RTCRtpSender | undefined, enc: Partial<RTCRtpEncodingParameters> & { networkPriority?: RTCPriorityType; codec?: RTCRtpCodec }, degradation?: RTCDegradationPreference): Promise<boolean> {
  if (!sender) return false;
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) return false;
    p.encodings[0] = { ...p.encodings[0], ...enc };
    if (degradation) (p as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = degradation;
    await sender.setParameters(p);
    return true;
  } catch { /* not negotiated yet / unsupported: defaults */
    return false;
  }
}

/**
 * Opus settings the browser API does not expose: voice with DTX (silence costs ~nothing), stream
 * audio in stereo at up to 128 kbps. Sections follow the transceiver order (1 mic, 4 stream audio).
 */
function tuneOpus(sdp: string): string {
  const parts = sdp.split(/(?=\r\nm=)/);
  return parts.map((sec, i) => {
    if (i !== MIC + 1 && i !== SCREEN_AUDIO + 1) return sec;
    const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sec)?.[1];
    if (!pt) return sec;
    const extra = i === MIC + 1 ? "usedtx=1" : "stereo=1;sprop-stereo=1;maxaveragebitrate=128000";
    return sec.replace(new RegExp(`(a=fmtp:${pt} [^\\r\\n]*)`), (line) => (line.includes(extra.split("=")[0]!) ? line : `${line};${extra}`));
  }).join("");
}
