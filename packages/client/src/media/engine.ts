import type { Device, types as msc } from "mediasoup-client";
import { denoise, type Denoised } from "./denoise";
import { remote, useRemote } from "./remote";
import { create } from "zustand";
import { STREAM_PRESETS, type EventName, type Events, type MediaSource, type RemoteProducer, type StreamPreset, type TransportParams } from "@nooxcord/shared";
import type { HostConnection } from "../net/connection";
import { platform } from "../platform";
import { useStore } from "../state/store";
import { VadGate, audioContext, idleMicContext, meter, micContext, type LevelMeter } from "./level";
import { pcmTrack, type PcmTrack } from "./pcm";
import { voiceSettings, useVoiceSettings } from "./settings";
import { WsMedia, wsMediaSupported, type WsAudio } from "./wsMedia";
import { t } from "../i18n";
import { startBackgroundCall, stopBackgroundCall } from "./background";

/*
 * Voice & stream engine (mediasoup-client). Owns the WebRTC transports, the microphone, the outgoing
 * screen share and every consumer. React reads its state through useVoice().
 */

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";
/** rtc = WebRTC (LAN / Hamachi / open port); ws = tunnel mode over WebSocket (higher latency). */
export type VoiceTransport = "rtc" | "ws";

/** Hosts reached through a tunnel can only carry WebSocket media. */
const isTunnelHost = (base: string): boolean => {
  try { return /\.(trycloudflare\.com|devtunnels\.ms)$/i.test(new URL(base).hostname); } catch { return false; }
};

export interface WatchedStream {
  stream: MediaStream; // video + optional stream audio
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface ShareOptions {
  preset: StreamPreset;
  /** Desktop: desktopCapturer source id. Web: the browser's own picker. */
  sourceId?: string;
  sourceSize?: { width: number; height: number; refreshRate: number | null };
  contentHint: "motion" | "detail";
  audio: boolean;
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
  sharing: { width: number; height: number; fps: number; audio: boolean; preset: StreamPreset } | null;
  watching: Record<string, WatchedStream | null>; // userId -> stream (null while connecting)
  focus: string | null;
  transport: VoiceTransport | null;
  /** My camera, while it is on. */
  camera: { facing: "user" | "environment"; canFlip: boolean } | null;
  /** Other people's cameras (userId -> video). */
  cams: Record<string, MediaStream>;
  /** Tunnel mode: audio dropouts so far and the playback buffer size (diagnostics, shown in the voice bar). */
  audioDiag: { dropouts: number; holdMs: number } | null;
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
  transport: null,
  camera: null,
  cams: {},
  audioDiag: null,
}));

const setV = (p: Partial<VoiceUi> | ((s: VoiceUi) => Partial<VoiceUi>)) => useVoice.setState(p);

interface ConsumerEntry {
  id: string;
  producerId: string;
  userId: string;
  source: MediaSource;
  track: MediaStreamTrack | null;
  close(): void;
  audioEl?: HTMLAudioElement;
  wsAudio?: WsAudio;
}

class VoiceEngine {
  private conn: HostConnection | null = null;
  private offConn: (() => void) | null = null;
  private device: Device | null = null;
  private send: msc.Transport | null = null;
  private recv: msc.Transport | null = null;
  private seq = 0;
  private mode: VoiceTransport = "rtc";
  private wsm: WsMedia | null = null;
  /** Always use tunnel mode (tests). */
  private forceWs = false;
  /** WebRTC failed during this call: stay on tunnel mode until the user joins again. */
  private fallbackWs = false;
  private micWsId: string | null = null;
  private errRejoinAt = 0;
  /** When the current WebRTC session started, and how many times the socket died soon after one. */
  private rtcSince = 0;
  private rtcDrops = 0;

  private micStream: MediaStream | null = null;
  private micSendTrack: MediaStreamTrack | null = null;
  private micProducer: msc.Producer | null = null;
  private micMeter: LevelMeter | null = null;
  private denoised: Denoised | null = null;
  private gate = new VadGate();
  private pttDown = false;
  private offPtt: (() => void) | null = null;
  private offHotkeys: (() => void) | null = null;

  private screenStream: MediaStream | null = null;
  private screenProducer: msc.Producer | null = null;
  private screenAudioProducer: msc.Producer | null = null;
  private sysAudio: PcmTrack | null = null;
  private shareOpts: ShareOptions | null = null;
  /** Tunnel mode: id of the screen producer the host made for our WebCodecs frames. */
  private screenWsId: string | null = null;

  private camStream: MediaStream | null = null;
  private camProducer: msc.Producer | null = null;
  private camWsId: string | null = null;
  private camFacing: "user" | "environment" = "user";

  private consumers = new Map<string, ConsumerEntry>();
  private producers = new Map<string, RemoteProducer>();

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
    // A new join tries WebRTC again: an earlier failure (a dropped connection) must not pin tunnel mode forever.
    this.fallbackWs = false;
    this.rtcDrops = 0;
    if (useVoice.getState().channelId) await this.teardown(true);
    setV({ status: "connecting", guildId, channelId, watching: {}, focus: null, sharing: null, audioDiag: null });
    this.bindConn(conn);
    try {
      await this.connect(conn, channelId, seq);
      await micPromise;
      if (seq !== this.seq) return;
      await this.produceMic();
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

  /** Signalling + transports; producers/consumers are (re)created afterwards. */
  private async connect(conn: HostConnection, channelId: string, seq: number): Promise<void> {
    const { muted, deafened } = useVoice.getState();
    const base = useStore.getState().http?.base ?? location.origin;
    const mode: VoiceTransport = wsMediaSupported() && (this.forceWs || this.fallbackWs || isTunnelHost(base)) ? "ws" : "rtc";
    const res = await conn.call("voice.join", { channelId, muted, deafened, transport: mode });
    if (seq !== this.seq) {
      conn.call("voice.leave", {}).catch(() => {});
      return;
    }
    this.mode = mode;
    this.producers.clear();
    for (const p of res.producers) this.producers.set(p.id, p);
    if (mode === "ws") {
      const wsm = new WsMedia(base.replace(/^http/, "ws") + "/media", res.wsTicket ?? "", () => {
        const v = useVoice.getState();
        if (seq === this.seq && v.guildId && v.channelId) void this.rejoin(v.guildId, v.channelId);
      });
      wsm.onAudioDiag = (d) => { if (this.wsm === wsm) setV({ audioDiag: d }); };
      await wsm.open();
      if (seq !== this.seq) return wsm.close();
      this.wsm = wsm;
      setV({ status: "connected", transport: "ws" });
      platform.media?.setInCall(true).catch(() => {});
      await Promise.all(res.producers.filter((p) => autoConsumed(p.source)).map((p) => this.consume(p).catch(() => {})));
      return;
    }
    // mediasoup-client is loaded on the first join (keeps the chat bundle small).
    const { Device: DeviceCtor } = await import("mediasoup-client");
    const device = new DeviceCtor();
    await device.load({ routerRtpCapabilities: res.rtpCapabilities as msc.RtpCapabilities });
    this.device = device;
    this.send = device.createSendTransport(this.transportOptions(res.send!));
    this.recv = device.createRecvTransport(this.transportOptions(res.recv!));
    for (const tr of [this.send, this.recv]) {
      const transport = tr;
      transport.on("connect", ({ dtlsParameters }, ok, fail) => {
        conn.call("media.connect", { transportId: transport.id, dtlsParameters: dtlsParameters as unknown as Record<string, unknown> }).then(() => ok(), fail);
      });
      transport.on("connectionstatechange", (st) => {
        if (st !== "failed" || seq !== this.seq) return;
        const v = useVoice.getState();
        if (wsMediaSupported() && !this.forceWs && !this.fallbackWs && v.guildId && v.channelId) {
          // UDP/TCP media port unreachable: fall back to WebSocket media through the main port.
          this.fallbackWs = true;
          useStore.getState().toast(t("err.voiceFallbackWs"), "info");
          void this.rejoin(v.guildId, v.channelId);
          return;
        }
        useStore.getState().toast(t("err.voiceMediaPort"), "error");
        void this.leave();
      });
    }
    this.send.on("produce", ({ kind, rtpParameters, appData }, ok, fail) => {
      conn
        .call("media.produce", { transportId: this.send!.id, kind, rtpParameters: rtpParameters as unknown as Record<string, unknown>, source: (appData as { source: MediaSource }).source })
        .then(({ id }) => ok({ id }), fail);
    });
    setV({ status: "connected", transport: "rtc" });
    this.rtcSince = Date.now();
    platform.media?.setInCall(true).catch(() => {});
    await Promise.all(res.producers.filter((p) => autoConsumed(p.source)).map((p) => this.consume(p).catch(() => {})));
  }

  private transportOptions(p: TransportParams): msc.TransportOptions {
    return {
      id: p.id,
      iceParameters: p.iceParameters as msc.IceParameters,
      iceCandidates: p.iceCandidates as msc.IceCandidate[],
      dtlsParameters: p.dtlsParameters as msc.DtlsParameters,
      sctpParameters: p.sctpParameters as msc.SctpParameters | undefined,
      iceServers: [],
    };
  }

  /** Close everything local; tell the server unless the session is already gone. */
  private async teardown(notifyServer: boolean): Promise<void> {
    const wasIn = !!useVoice.getState().channelId;
    if (notifyServer && wasIn) await this.conn?.call("voice.leave", {}).catch(() => {});
    this.closeTransports();
    this.stopScreenLocal();
    this.stopCameraLocal();
    this.closeMic();
    // Out of voice for good (not a channel switch): the mic context's audio thread can sleep.
    setTimeout(() => {
      if (useVoice.getState().channelId) return;
      if (!this.micStream) idleMicContext();
      stopBackgroundCall();
    }, 1000);
    setV({ status: "idle", guildId: null, channelId: null, watching: {}, focus: null, sharing: null, selfSpeaking: false, transport: null, camera: null, cams: {}, audioDiag: null });
    platform.media?.setInCall(false).catch(() => {});
  }

  private closeTransports() {
    for (const c of this.consumers.values()) this.dropConsumer(c);
    this.consumers.clear();
    this.producers.clear();
    this.micProducer = null;
    this.screenProducer = null;
    this.screenAudioProducer = null;
    this.camProducer = null;
    this.camWsId = null;
    this.screenWsId = null;
    this.send?.close();
    this.recv?.close();
    this.send = this.recv = null;
    this.device = null;
    this.wsm?.close();
    this.wsm = null;
    this.micWsId = null;
  }

  // ---------- server events ----------

  private onEvent<E extends EventName>(e: E, raw: Events[E]): void {
    const v = useVoice.getState();
    switch (e) {
      case "ready": {
        // Socket reconnected: the old session died with the old socket. Rejoin.
        if (v.channelId && v.guildId) {
          // Seen over Hamachi: the connection stalls ~15 s after WebRTC media starts, again and again
          // (host.log, 2026-11-07/08). The first such drop already moves this call off WebRTC: to the
          // host's tunnel when one is open (desktop app), else media over this same WebSocket.
          if (this.mode === "rtc" && this.rtcSince && Date.now() - this.rtcSince < 60_000) this.rtcDrops++;
          this.rtcSince = 0;
          if (this.rtcDrops >= 1 && !this.fallbackWs) {
            this.fallbackWs = true;
            const st = useStore.getState();
            const tunnelUrl = st.hostInfo?.tunnelUrl ?? null;
            if (tunnelUrl && platform.kind === "desktop" && st.hostUrl && !sameOrigin(st.hostUrl, tunnelUrl)) {
              st.toast(t("err.voiceUnstableMoved"), "info");
              void switchToTunnel(tunnelUrl).catch(() => {
                st.toast(t("tunnelSwitch.failed"), "error");
                void this.rejoin(v.guildId!, v.channelId!);
              });
              break;
            }
            if (wsMediaSupported()) st.toast(t("err.voiceUnstable"), "info");
          }
          void this.rejoin(v.guildId, v.channelId);
        }
        break;
      }
      case "voice.ended": {
        if (!v.channelId) break;
        const { reason } = raw as Events["voice.ended"];
        if (reason === "error" && v.guildId && Date.now() - this.errRejoinAt > 10_000) {
          this.errRejoinAt = Date.now();
          // The host's media server restarted: our session is gone, join again.
          void this.rejoin(v.guildId, v.channelId);
          break;
        }
        this.seq++;
        void this.teardown(false);
        useStore.getState().toast(reason === "replaced" ? t("err.voiceReplaced") : t("err.voiceRemoved"), "info");
        break;
      }
      case "media.producer": {
        const p = raw as Events["media.producer"];
        if (p.channelId !== v.channelId) break;
        this.producers.set(p.id, p);
        if (autoConsumed(p.source) || p.userId in v.watching) void this.consume(p).catch(() => {});
        break;
      }
      case "media.producerClosed": {
        this.producers.delete((raw as Events["media.producerClosed"]).producerId);
        break;
      }
      case "media.producerPaused": {
        const d = raw as Events["media.producerPaused"];
        const p = this.producers.get(d.producerId);
        if (p) p.paused = d.paused;
        break;
      }
      case "media.consumerClosed": {
        const c = this.consumers.get((raw as Events["media.consumerClosed"]).consumerId);
        if (c) {
          this.consumers.delete(c.id);
          this.dropConsumer(c);
        }
        break;
      }
      case "voice.state": {
        // A stream I was watching ended.
        const s = raw as Events["voice.state"];
        if (s.channelId === v.channelId && !s.stream && s.userId in v.watching) this.forgetWatch(s.userId);
        break;
      }
      case "voice.leave": {
        const d = raw as Events["voice.leave"];
        if (d.userId in v.watching) this.forgetWatch(d.userId);
        break;
      }
    }
  }

  private async rejoin(guildId: string, channelId: string) {
    const conn = this.conn;
    if (!conn) return;
    const watching = Object.keys(useVoice.getState().watching);
    const share = this.shareOpts && this.screenStream ? this.shareOpts : null;
    const cam = !!this.camStream;
    const seq = ++this.seq;
    setV({ status: "reconnecting" });
    this.closeTransports();
    try {
      await this.connect(conn, channelId, seq);
      if (seq !== this.seq) return;
      await this.produceMic();
      if (share) await this.publishScreen(share).catch(() => this.stopScreenLocal());
      if (cam) await this.publishCamera().catch(() => this.stopCameraLocal());
      for (const uid of watching) await this.watch(uid).catch(() => this.forgetWatch(uid));
    } catch {
      if (seq === this.seq) {
        await this.teardown(false);
        useStore.getState().toast(t("err.voiceRejoin"), "error");
      }
    }
    void guildId;
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
      // Browsers give no microphone on plain http:// (a LAN / Hamachi address): only https or localhost.
      const msg = !window.isSecureContext ? t("err.micInsecure") : name === "NotAllowedError" ? t("err.micDenied") : name === "NotFoundError" ? t("err.micMissing") : t("err.micFailed");
      setV({ micError: msg });
      useStore.getState().toast(msg, "error");
      return;
    }
    let track = this.micStream.getAudioTracks()[0]!;
    const stream = this.micStream;
    this.denoised = await denoise(track, s.noiseMode).catch((e: unknown) => {
      console.warn("[voice] noise suppression unavailable", e);
      return null;
    });
    if (this.micStream !== stream) { this.denoised?.stop(); this.denoised = null; return; } // closed meanwhile
    if (this.denoised) track = this.denoised.track; // the gate also hears the cleaned sound: fewer false opens
    // The producer gets a clone so the gate can silence it while the meter still hears the original.
    this.micSendTrack = track.clone();
    this.micSendTrack.enabled = false;
    this.micMeter = await meter(track, (db) => this.onMicLevel(db), (n) => this.onMicHoles(n)).catch(() => null);
    this.watchPtt();
    this.watchHotkeys();
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
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSendTrack?.stop();
    this.micStream = null;
    this.micSendTrack = null;
    this.micProducer = null;
    this.wsm?.stopMic();
    this.micWsId = null;
    this.offPtt?.();
    this.offPtt = null;
    this.pttDown = false;
    this.offHotkeys?.();
    this.offHotkeys = null;
  }

  private async produceMic(): Promise<void> {
    const { muted } = useVoice.getState();
    if (this.mode === "ws") {
      const wsm = this.wsm, track = this.micSendTrack;
      if (!wsm || !track || this.micWsId) return;
      try {
        await wsm.startMic(track);
      } catch (e) {
        setV({ micError: (e as Error).message });
        useStore.getState().toast((e as Error).message, "error");
        return;
      }
      const { id } = await this.conn!.call("media.produce", { transportId: "ws", kind: "audio", rtpParameters: {}, source: "mic" });
      this.micWsId = id;
      if (muted) await this.pauseMic(true);
      return;
    }
    if (!this.send || !this.micSendTrack || this.micProducer) return;
    this.micProducer = await this.send.produce({
      track: this.micSendTrack,
      stopTracks: false,
      // Voice first when the uplink is busy (a stream or a game download): bandwidth and DSCP priority.
      encodings: [{ priority: "high", networkPriority: "high" }],
      codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
      appData: { source: "mic" },
    });
    if (muted) await this.pauseMic(true);
  }

  private onMicLevel(db: number) {
    const s = voiceSettings();
    const v = useVoice.getState();
    const open = s.mode === "ptt" ? this.pttDown : this.gate.update(db, s.vadThreshold);
    const speaking = open && !v.muted && !v.deafened && (!!this.micProducer || !!this.micWsId);
    if (this.micSendTrack) this.micSendTrack.enabled = speaking;
    this.wsm?.setMicOpen(speaking);
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

  private async pauseMic(paused: boolean) {
    const p = this.micProducer;
    const id = p?.id ?? this.micWsId;
    if (!id) return;
    if (p) {
      if (paused) p.pause();
      else p.resume();
    }
    await this.conn?.call("media.pauseProducer", { producerId: id, paused }).catch(() => {});
  }

  async setMuted(muted: boolean): Promise<void> {
    const v = useVoice.getState();
    // Unmuting while deafened also undeafens (as people expect).
    const deafened = !muted && v.deafened ? false : v.deafened;
    setV({ muted, deafened });
    this.applyDeafen();
    if (!v.channelId) return;
    await this.pauseMic(muted || deafened);
    await this.conn?.call("voice.update", { muted, deafened }).catch(() => {});
  }

  async setDeafened(deafened: boolean): Promise<void> {
    const v = useVoice.getState();
    setV({ deafened });
    this.applyDeafen();
    if (!v.channelId) return;
    await this.pauseMic(deafened || v.muted);
    await this.conn?.call("voice.update", { deafened }).catch(() => {});
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
    const old = this.micProducer;
    const oldId = old?.id ?? this.micWsId;
    this.closeMic();
    old?.close();
    if (oldId) await this.conn?.call("media.closeProducer", { producerId: oldId }).catch(() => {});
    await this.openMic();
    await this.produceMic().catch(() => {});
  }

  // ---------- playback ----------

  private applyDeafen() {
    const { deafened } = useVoice.getState();
    for (const c of this.consumers.values()) {
      if (c.audioEl) c.audioEl.muted = deafened;
      c.wsAudio?.setMuted(deafened);
    }
  }

  setUserVolume(userId: string, volume: number) {
    useVoiceSettings.getState().set({ volumes: { ...voiceSettings().volumes, [userId]: volume } });
    for (const c of this.consumers.values()) {
      if (c.userId !== userId || c.source !== "mic") continue;
      if (c.audioEl) c.audioEl.volume = Math.min(1, volume);
      c.wsAudio?.setVolume(volume);
    }
  }

  async setOutputDevice(id: string) {
    for (const c of this.consumers.values()) {
      const el = c.audioEl as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | undefined;
      await el?.setSinkId?.(id).catch(() => {});
    }
  }

  private async consume(p: RemoteProducer): Promise<void> {
    if (this.mode === "ws") return this.consumeWs(p);
    const conn = this.conn;
    const device = this.device;
    const recv = this.recv;
    if (!conn || !device || !recv) return;
    for (const c of this.consumers.values()) if (c.producerId === p.id) return;
    const params = await conn.call("media.consume", { producerId: p.id, rtpCapabilities: device.recvRtpCapabilities as unknown as Record<string, unknown> });
    if (recv !== this.recv) return;
    const consumer = await recv.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters as msc.RtpParameters,
      appData: { userId: params.userId, source: params.source },
    });
    if (params.kind === "audio") holdJitter(consumer.rtpReceiver, params.source === "mic" ? 80 : 120);
    const entry: ConsumerEntry = { id: consumer.id, producerId: p.id, userId: params.userId, source: params.source, track: consumer.track, close: () => consumer.close() };
    this.consumers.set(consumer.id, entry);
    if (params.source === "mic") {
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = new MediaStream([consumer.track]);
      el.volume = Math.min(1, voiceSettings().volumes[params.userId] ?? 1);
      el.muted = useVoice.getState().deafened;
      const sink = voiceSettings().outputDeviceId;
      const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (sink && withSink.setSinkId) await withSink.setSinkId(sink).catch(() => {});
      void el.play().catch(() => {});
      entry.audioEl = el;
    } else if (params.source === "camera") {
      this.setCam(params.userId, consumer.track);
    } else {
      this.attachToWatch(params.userId, consumer.track);
    }
    await conn.call("media.resume", { consumerId: consumer.id });
  }

  /** Tunnel mode: frames arrive on the /media socket and are decoded with WebCodecs. */
  private async consumeWs(p: RemoteProducer): Promise<void> {
    const conn = this.conn;
    const wsm = this.wsm;
    if (!conn || !wsm) return;
    for (const c of this.consumers.values()) if (c.producerId === p.id) return;
    const params = await conn.call("media.consume", { producerId: p.id, rtpCapabilities: {} });
    if (wsm !== this.wsm || params.tag === null) return;
    const tag = params.tag;
    const entry: ConsumerEntry = { id: params.id, producerId: p.id, userId: params.userId, source: params.source, track: null, close: () => wsm.remove(tag) };
    this.consumers.set(params.id, entry);
    if (params.kind === "audio") {
      const vols = voiceSettings().volumes;
      const vol = params.source === "mic" ? vols[params.userId] ?? 1 : vols[`stream:${params.userId}`] ?? 1;
      entry.wsAudio = await wsm.addAudio(tag, params.source === "mic" ? 1 : 2, vol, useVoice.getState().deafened);
    } else {
      const track = wsm.addVideo(tag);
      entry.track = track;
      entry.close = () => { wsm.remove(tag); track.stop(); };
      if (params.source === "camera") this.setCam(params.userId, track);
      else this.attachToWatch(params.userId, track);
    }
    await conn.call("media.resume", { consumerId: params.id });
  }

  private dropConsumer(c: ConsumerEntry) {
    if (c.audioEl) {
      c.audioEl.pause();
      c.audioEl.srcObject = null;
    }
    if (c.source === "camera") {
      setV((s) => {
        const cams = { ...s.cams };
        delete cams[c.userId];
        return { cams };
      });
    } else if (c.source !== "mic" && c.track) {
      const w = useVoice.getState().watching[c.userId];
      if (w) {
        w.stream.removeTrack(c.track);
        setV((s) => ({ watching: { ...s.watching, [c.userId]: { ...w, hasVideo: w.stream.getVideoTracks().length > 0, hasAudio: w.stream.getAudioTracks().length > 0 } } }));
      }
    }
    c.close();
  }

  // ---------- watching streams ----------

  async watch(userId: string): Promise<void> {
    const conn = this.conn;
    if (!conn || !useVoice.getState().channelId) return;
    // First stream: it fills the stage. Another one: side by side (no focus) until one is clicked.
    setV((s) => ({ watching: { ...s.watching, [userId]: s.watching[userId] ?? null }, focus: Object.keys(s.watching).some((id) => id !== userId) ? null : userId }));
    try {
      const list = await conn.call("stream.watch", { userId, watching: true });
      for (const p of list) this.producers.set(p.id, p);
      await Promise.all(list.map((p) => this.consume(p)));
      this.ensureWatchEntry(userId);
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

  private ensureWatchEntry(userId: string): WatchedStream {
    const cur = useVoice.getState().watching[userId];
    if (cur) return cur;
    const w: WatchedStream = { stream: new MediaStream(), hasVideo: false, hasAudio: false };
    setV((s) => ({ watching: { ...s.watching, [userId]: w } }));
    return w;
  }

  private attachToWatch(userId: string, track: MediaStreamTrack) {
    if (!(userId in useVoice.getState().watching)) return;
    const w = this.ensureWatchEntry(userId);
    w.stream.addTrack(track);
    setV((s) => ({ watching: { ...s.watching, [userId]: { stream: w.stream, hasVideo: w.stream.getVideoTracks().length > 0, hasAudio: w.stream.getAudioTracks().length > 0 } } }));
  }

  private forgetWatch(userId: string) {
    for (const c of [...this.consumers.values()]) {
      if (c.userId === userId && (c.source === "screen" || c.source === "screen-audio")) {
        this.consumers.delete(c.id);
        c.close();
        this.conn?.call("media.closeConsumer", { consumerId: c.id }).catch(() => {});
      }
    }
    setV((s) => {
      const watching = { ...s.watching };
      delete watching[userId];
      return { watching, focus: s.focus === userId ? Object.keys(watching)[0] ?? null : s.focus };
    });
  }

  setFocus(userId: string | null) {
    setV({ focus: userId });
    if (this.mode === "ws") return; // tunnel: always the small layer
    // Big tile gets the high simulcast layer, small tiles the low one (host upload, CLAUDE.md §2.4).
    const v = useVoice.getState();
    const many = Object.keys(v.watching).length > 1;
    for (const c of this.consumers.values()) {
      if (c.source !== "screen") continue;
      const spatial = !many || c.userId === userId ? 1 : 0;
      this.conn?.call("media.layers", { consumerId: c.id, spatial }).catch(() => {});
    }
  }

  // ---------- camera ----------

  private setCam(userId: string, track: MediaStreamTrack) {
    setV((s) => ({ cams: { ...s.cams, [userId]: new MediaStream([track]) } }));
  }

  /** Opens the camera. Call straight from a click (iOS wants getUserMedia inside the gesture). */
  async startCamera(): Promise<void> {
    const v = useVoice.getState();
    if (!v.channelId || v.camera || this.camStream || !this.conn) return;
    const stream = await this.openCamera(this.camFacing, true);
    if (!useVoice.getState().channelId) { stream.getTracks().forEach((x) => x.stop()); return; }
    this.camStream = stream;
    const track = stream.getVideoTracks()[0]!;
    track.addEventListener("ended", () => { if (this.camStream === stream) void this.stopCamera(); });
    try {
      await this.publishCamera();
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

  private async publishCamera(): Promise<void> {
    const track = this.camStream?.getVideoTracks()[0];
    const conn = this.conn;
    if (!track || !conn) return;
    if (this.mode === "ws") {
      const wsm = this.wsm;
      if (!wsm) return;
      await wsm.startVideo("camera", track);
      const { id } = await conn.call("media.produce", { transportId: "ws", kind: "video", rtpParameters: {}, source: "camera" });
      this.camWsId = id;
      return;
    }
    const send = this.send, device = this.device;
    if (!send || !device) return;
    const caps = device.rtpCapabilities.codecs ?? [];
    // H.264 first: tunnel viewers and iPhones decode it in hardware.
    const codec = caps.find((c) => c.mimeType.toLowerCase() === "video/h264") ?? caps.find((c) => c.mimeType.toLowerCase() === "video/vp8");
    track.contentHint = "motion";
    this.camProducer = await send.produce({
      track,
      stopTracks: false,
      codec,
      encodings: [{ maxBitrate: 600_000, maxFramerate: 24 }],
      codecOptions: { videoGoogleStartBitrate: 400 },
      appData: { source: "camera" },
    });
  }

  async stopCamera(): Promise<void> {
    const id = this.camProducer?.id ?? this.camWsId;
    this.stopCameraLocal();
    if (id) await this.conn?.call("media.closeProducer", { producerId: id }).catch(() => {});
  }

  private stopCameraLocal() {
    this.camProducer?.close();
    this.camProducer = null;
    this.camWsId = null;
    this.wsm?.stopVideo("camera");
    this.camStream?.getTracks().forEach((x) => x.stop());
    this.camStream = null;
    if (useVoice.getState().camera) setV({ camera: null });
  }

  /** Front <-> back camera (phones). The producer stays; only its track changes. */
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
    track.addEventListener("ended", () => { if (this.camStream === stream) void this.stopCamera(); });
    if (this.camProducer) await this.camProducer.replaceTrack({ track });
    this.wsm?.setVideoTrack("camera", track);
    this.camStream = stream;
    this.camFacing = (track.getSettings().facingMode as "user" | "environment" | undefined) ?? got;
    setV((s) => ({ camera: s.camera ? { ...s.camera, facing: this.camFacing } : null }));
  }

  /** My own camera (for the self view). */
  localCamera(): MediaStream | null {
    return this.camStream;
  }

  // ---------- screen share ----------

  async startScreen(opts: ShareOptions): Promise<void> {
    const tunnel = this.mode === "ws";
    if (!this.send && !(tunnel && this.wsm)) throw new Error(t("err.joinVoiceFirst"));
    if (tunnel && (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined")) throw new Error(t("err.screenNoEncoder"));
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
    if (!video) throw new Error(t("err.noVideo"));
    video.contentHint = opts.contentHint;
    video.addEventListener("ended", () => void this.stopScreen());

    // Desktop system audio, NooXCord's own sound excluded (CLAUDE.md §6.3).
    let audioTrack = stream.getAudioTracks()[0] ?? null;
    if (!audioTrack && opts.audio && platform.media) audioTrack = await this.startSystemAudio();
    if (audioTrack) stream.addTrack(audioTrack);

    try {
      await this.publishScreen({ ...opts, testTrack: undefined, testAudio: undefined });
    } catch (e) {
      this.stopScreenLocal();
      throw e;
    }
    const st = video.getSettings();
    void this.sendThumbnail(video);
    setV({ sharing: { width: st.width ?? width, height: st.height ?? height, fps: Math.round(st.frameRate ?? fps), audio: !!audioTrack, preset: opts.preset } });
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

  private async publishScreen(opts: ShareOptions): Promise<void> {
    const stream = this.screenStream;
    if (this.mode === "ws") return this.publishScreenWs(stream);
    const send = this.send;
    const device = this.device;
    if (!send || !stream || !device) return;
    const video = stream.getVideoTracks()[0]!;
    const preset = STREAM_PRESETS[opts.preset];
    const caps = device.rtpCapabilities.codecs ?? [];
    const codec = caps.find((c) => c.mimeType.toLowerCase() === "video/h264") ?? caps.find((c) => c.mimeType.toLowerCase() === "video/vp8");
    this.screenProducer = await send.produce({
      track: video,
      stopTracks: false,
      codec,
      // Two simulcast layers: full quality + a quarter-size layer for small tiles and weak links.
      encodings: [
        { rid: "r0", scaleResolutionDownBy: 2, maxBitrate: Math.round(preset.bitrate * 0.2), maxFramerate: Math.min(30, preset.fps) },
        { rid: "r1", scaleResolutionDownBy: 1, maxBitrate: preset.bitrate },
      ],
      codecOptions: { videoGoogleStartBitrate: 1500 },
      appData: { source: "screen" },
    });
    const audio = stream.getAudioTracks()[0];
    if (audio) {
      this.screenAudioProducer = await send.produce({
        track: audio,
        stopTracks: false,
        encodings: [{ priority: "high", networkPriority: "high" }],
        codecOptions: { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 128_000 },
        appData: { source: "screen-audio" },
      });
    }
    const st = video.getSettings();
    await this.conn!.call("stream.start", {
      width: Math.max(1, Math.round(st.width ?? 1280)),
      height: Math.max(1, Math.round(st.height ?? 720)),
      fps: Math.max(1, Math.round(st.frameRate ?? preset.fps)),
      audio: !!audio,
      tunnelHigh: useVoiceSettings.getState().streamTunnelHigh,
    });
  }

  /** Streamer: full or small quality for viewers who watch through a tunnel; also remembered for next time. */
  async setTunnelQuality(high: boolean): Promise<void> {
    useVoiceSettings.getState().set({ streamTunnelHigh: high });
    if (useVoice.getState().sharing) await this.conn?.call("stream.tunnelQuality", { high });
  }

  /** Tunnel mode: the client encodes H.264 itself (≤1280x720, 15 fps); stream audio goes as stereo Opus. */
  private async publishScreenWs(stream: MediaStream | null): Promise<void> {
    const wsm = this.wsm, conn = this.conn;
    const video = stream?.getVideoTracks()[0];
    if (!wsm || !conn || !video) return;
    await wsm.startVideo("screen", video);
    const { id } = await conn.call("media.produce", { transportId: "ws", kind: "video", rtpParameters: {}, source: "screen" });
    this.screenWsId = id;
    let audio = stream!.getAudioTracks()[0] ?? null;
    if (audio) {
      try {
        await wsm.startScreenAudio(audio);
        await conn.call("media.produce", { transportId: "ws", kind: "audio", rtpParameters: {}, source: "screen-audio" });
      } catch (e) {
        // An older host or no Opus encoder: share without sound rather than fail.
        wsm.stopScreenAudio();
        audio = null;
        useStore.getState().toast(t("err.streamAudioTunnel", { msg: (e as Error).message }), "info");
      }
    }
    const st = video.getSettings();
    const w = st.width ?? 1280, h = st.height ?? 720, k = Math.min(1, 1280 / w, 720 / h);
    await conn.call("stream.start", { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), fps: 15, audio: !!audio });
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

  private stopScreenLocal() {
    this.screenProducer?.close();
    this.screenAudioProducer?.close();
    this.screenProducer = this.screenAudioProducer = null;
    this.screenWsId = null;
    this.wsm?.stopVideo("screen");
    this.wsm?.stopScreenAudio();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.shareOpts = null;
    if (this.sysAudio) {
      this.sysAudio.stop();
      this.sysAudio = null;
      void platform.media?.stopSystemAudio();
    }
    setV({ sharing: null });
  }

  /** My own outgoing screen (for the local preview tile). */
  localScreen(): MediaStream | null {
    return this.screenStream;
  }

  /** Debug/test helper: what I currently receive. */
  debugConsumers(): { userId: string; source: MediaSource; live: boolean }[] {
    return [...this.consumers.values()].map((c) => ({ userId: c.userId, source: c.source, live: !!c.track && c.track.readyState === "live" || !!c.wsAudio }));
  }

  /** Debug/test helper: transport stats summary. */
  async stats(): Promise<{ sendBytes: number; recvBytes: number; framesDecoded: number; audioRecvBytes: number }> {
    let sendBytes = 0, recvBytes = 0, framesDecoded = 0, audioRecvBytes = 0;
    const s = await this.send?.getStats();
    s?.forEach((r: { type: string; bytesSent?: number }) => { if (r.type === "outbound-rtp") sendBytes += r.bytesSent ?? 0; });
    const rs = await this.recv?.getStats();
    rs?.forEach((r: { type: string; kind?: string; bytesReceived?: number; framesDecoded?: number }) => {
      if (r.type !== "inbound-rtp") return;
      recvBytes += r.bytesReceived ?? 0;
      if (r.kind === "video") framesDecoded += r.framesDecoded ?? 0;
      else audioRecvBytes += r.bytesReceived ?? 0;
    });
    if (this.wsm) {
      const w = this.wsm.stats;
      sendBytes += w.sentBytes;
      recvBytes += w.bytes;
      framesDecoded += w.framesDecoded;
      audioRecvBytes += w.audioBytes;
    }
    return { sendBytes, recvBytes, framesDecoded, audioRecvBytes };
  }
}

export const voice = new VoiceEngine();

const sameOrigin = (a: string, b: string): boolean => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

/**
 * Moves this desktop session to the host's tunnel URL (same account, server and channel) and, if in
 * voice, back into the same voice channel once connected (CLAUDE.md §10.4).
 */
export async function switchToTunnel(tunnelUrl: string): Promise<void> {
  const v = useVoice.getState();
  const rejoin = v.guildId && v.channelId ? { guildId: v.guildId, channelId: v.channelId } : null;
  if (rejoin) await voice.leave();
  await useStore.getState().switchAddress(tunnelUrl);
  useStore.getState().toast(t("tunnelSwitch.done"));
  if (rejoin) {
    const off = useStore.subscribe((st) => {
      if (st.connStatus !== "ready") return;
      off();
      void voice.join(rejoin.guildId, rejoin.channelId);
    });
  }
}

// Leave voice when the host connection goes away for good (logout / switch host).
useStore.subscribe((s, prev) => {
  if (prev.conn && !s.conn && useVoice.getState().channelId) void voice.leave();
  if (prev.conn && s.conn && prev.conn !== s.conn && useVoice.getState().channelId) void voice.leave();
});

// Dev/test hook (used by the Electron voice self-test).
(window as unknown as { __nx?: unknown }).__nx = { voice, useVoice, useStore, remote, useRemote, denoise, meter };

/** Voices and cameras go to everyone in the channel; screen streams only to people watching them. */
function autoConsumed(source: MediaSource): boolean {
  return source === "mic" || source === "camera";
}

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
/** Shortcut string of a key press ("Ctrl+Shift+KeyM"); null while only modifiers are held. */
export function comboOf(e: { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.code].filter(Boolean).join("+");
}

/*
 * Minimum playout buffer for a received audio track. Over jittery paths (Wi-Fi, Hamachi, a busy host)
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
