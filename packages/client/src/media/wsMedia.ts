import { audioContext } from "./level";
import { pcmTrack, type PcmTrack } from "./pcm";
import { t } from "../i18n";

/*
 * Tunnel media (NXM-WS, CLAUDE.md §2.3 way 3). Tunnels carry only HTTP/WebSocket, so audio and
 * video arrive as whole Opus / H.264 / VP8 frames on wss://host/media and are decoded with WebCodecs.
 * Frame layout: see packages/server/src/rtp.ts.
 */

const FRAME_AUDIO = 1;
const FRAME_VIDEO = 2;
const FRAME_MIC = 3;
const FRAME_CAM = 4;
const FRAME_KEYREQ = 5;

const CAPTURE = `
class NxCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("nx-capture", NxCapture);
`;

let captureLoaded: Promise<void> | null = null;

/** Can this browser use tunnel mode? (Listening needs AudioDecoder; video needs VideoDecoder.) */
export function wsMediaSupported(): boolean {
  return typeof AudioDecoder !== "undefined" && typeof EncodedAudioChunk !== "undefined";
}

/** Plays decoded audio straight to the speakers (works on iOS, unlike MediaStream in <audio>). */
export interface WsAudio {
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  stop(): void;
}

interface AudioSink {
  dec: AudioDecoder;
  pcm: PcmTrack;
  port: MessagePort;
  gain: GainNode;
  src: MediaStreamAudioSourceNode;
}

interface VideoSink {
  dec: VideoDecoder | null;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  vp8: boolean;
  waitKey: boolean;
}

/** avc1.PPCCLL from the SPS of an Annex-B key frame. */
function avcCodec(data: Uint8Array): string {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3]! & 0x1f) === 7) {
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return `avc1.${hex(data[i + 4]!)}${hex(data[i + 5]!)}${hex(data[i + 6]!)}`;
    }
  }
  return "avc1.42E01F";
}

export class WsMedia {
  private ws: WebSocket | null = null;
  private audio = new Map<number, AudioSink>();
  private video = new Map<number, VideoSink>();
  private mic: { enc: AudioEncoder; node: AudioWorkletNode; src: MediaStreamAudioSourceNode; sink: GainNode } | null = null;
  private micOpen = false;
  private cam: CamSender | null = null;
  readonly stats = { framesDecoded: 0, audioBytes: 0, bytes: 0, sentBytes: 0 };

  constructor(private url: string, private ticket: string, private onClosed: () => void) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const timer = setTimeout(() => { ws.close(); reject(new Error(t("err.mediaTimeout"))); }, 10_000);
      let ready = false;
      ws.onopen = () => ws.send(JSON.stringify({ ticket: this.ticket }));
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          if (!ready) { ready = true; clearTimeout(timer); resolve(); }
          return;
        }
        this.onFrame(e.data as ArrayBuffer);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!ready) reject(new Error(t("err.mediaFailed")));
        else if (this.ws === ws) this.onClosed();
      };
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const tag of [...this.audio.keys(), ...this.video.keys()]) this.remove(tag);
    this.stopMic();
    this.stopCamera();
  }

  // ---------- receiving ----------

  async addAudio(tag: number, channels: 1 | 2, volume: number, muted: boolean): Promise<WsAudio> {
    const ch = new MessageChannel();
    const pcm = await pcmTrack(ch.port2, 48000, channels);
    const c = audioContext();
    const src = c.createMediaStreamSource(new MediaStream([pcm.track]));
    const gain = c.createGain();
    gain.gain.value = muted ? 0 : volume;
    src.connect(gain).connect(c.destination);
    const dec = new AudioDecoder({
      output: (ad) => {
        const n = ad.numberOfFrames, k = ad.numberOfChannels;
        const out = new Float32Array(n * channels);
        try {
          const plane = new Float32Array(n);
          for (let c2 = 0; c2 < channels; c2++) {
            ad.copyTo(plane, { planeIndex: Math.min(c2, k - 1), format: "f32-planar" });
            for (let i = 0; i < n; i++) out[i * channels + c2] = plane[i]!;
          }
        } catch {
          ad.close();
          return;
        }
        ad.close();
        ch.port1.postMessage(out, [out.buffer]);
      },
      error: () => { /* a broken packet; the next one decodes */ },
    });
    dec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: channels });
    this.audio.set(tag, { dec, pcm, port: ch.port1, gain, src });
    let vol = volume, mute = muted;
    const apply = () => (gain.gain.value = mute ? 0 : vol);
    return {
      setVolume: (v) => { vol = v; apply(); },
      setMuted: (m) => { mute = m; apply(); },
      stop: () => this.remove(tag),
    };
  }

  /** Decoded video as a MediaStreamTrack (canvas capture), so the normal <video> tiles work. */
  addVideo(tag: number): MediaStreamTrack {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, canvas.width, canvas.height);
    this.video.set(tag, { dec: null, canvas, g, vp8: false, waitKey: true });
    return canvas.captureStream().getVideoTracks()[0]!;
  }

  remove(tag: number): void {
    const a = this.audio.get(tag);
    if (a) {
      this.audio.delete(tag);
      try { a.dec.close(); } catch { /* closed */ }
      try { a.src.disconnect(); a.gain.disconnect(); } catch { /* closed */ }
      a.pcm.stop();
      a.port.close();
    }
    const v = this.video.get(tag);
    if (v) {
      this.video.delete(tag);
      try { v.dec?.close(); } catch { /* closed */ }
    }
  }

  private onFrame(buf: ArrayBuffer) {
    this.stats.bytes += buf.byteLength;
    const dv = new DataView(buf);
    const kind = dv.getUint8(0);
    if (kind === FRAME_KEYREQ) {
      if (this.cam) this.cam.forceKey = true;
      return;
    }
    const tag = dv.getUint16(1);
    if (kind === FRAME_AUDIO) {
      const a = this.audio.get(tag);
      if (!a || a.dec.state !== "configured") return;
      this.stats.audioBytes += buf.byteLength;
      const ts = dv.getUint32(3);
      a.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((ts / 48) * 1000), data: new Uint8Array(buf, 7) }));
    } else if (kind === FRAME_VIDEO) {
      const v = this.video.get(tag);
      if (!v) return;
      const flags = dv.getUint8(3);
      const key = (flags & 1) !== 0;
      const data = new Uint8Array(buf, 8);
      if (v.waitKey && !key) return;
      if (key && (!v.dec || v.dec.state !== "configured")) this.configureVideo(v, (flags & 2) !== 0, data);
      const dec = v.dec;
      if (!dec || dec.state !== "configured") return;
      if (dec.decodeQueueSize > 6 && !key) { v.waitKey = true; return; } // falling behind: skip to the next key frame
      v.waitKey = false;
      const ts = dv.getUint32(4);
      try {
        dec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Math.round((ts / 90) * 1000), data }));
      } catch {
        v.waitKey = true;
      }
    }
  }

  private configureVideo(v: VideoSink, vp8: boolean, keyData: Uint8Array) {
    try { v.dec?.close(); } catch { /* closed */ }
    v.vp8 = vp8;
    const dec = new VideoDecoder({
      output: (frame) => {
        if (v.canvas.width !== frame.displayWidth || v.canvas.height !== frame.displayHeight) {
          v.canvas.width = frame.displayWidth;
          v.canvas.height = frame.displayHeight;
        }
        v.g.drawImage(frame, 0, 0);
        frame.close();
        this.stats.framesDecoded++;
      },
      error: () => {
        v.waitKey = true;
        v.dec = null; // reconfigured on the next key frame
      },
    });
    dec.configure({ codec: vp8 ? "vp8" : avcCodec(keyData), optimizeForLatency: true });
    v.dec = dec;
  }

  // ---------- microphone ----------

  /** Encodes the microphone to Opus (20 ms frames) and sends it while the voice gate is open. */
  async startMic(track: MediaStreamTrack): Promise<void> {
    if (typeof AudioEncoder === "undefined") throw new Error(t("err.wsNoEncoder"));
    const config: AudioEncoderConfig = { codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32_000 };
    if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error(t("err.wsNoOpus"));
    const c = audioContext();
    captureLoaded ??= (async () => {
      const url = URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" }));
      try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    })();
    await captureLoaded;
    this.stopMic();
    const enc = new AudioEncoder({
      output: (chunk) => {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1 || ws.bufferedAmount > 64_000) return;
        const out = new Uint8Array(1 + chunk.byteLength);
        out[0] = FRAME_MIC;
        chunk.copyTo(out.subarray(1));
        ws.send(out);
        this.stats.sentBytes += out.byteLength;
      },
      error: () => { /* keep going */ },
    });
    enc.configure(config);
    const src = c.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(c, "nx-capture");
    const sink = c.createGain();
    sink.gain.value = 0;
    src.connect(node).connect(sink).connect(c.destination);
    const rate = c.sampleRate;
    const FRAME = 960;
    let acc = new Float32Array(FRAME), fill = 0, samples = 0, pos = 0;
    const step = rate / 48000; // resample if the context is not 48 kHz
    node.port.onmessage = (e) => {
      const block = e.data as Float32Array;
      if (!this.micOpen) { fill = 0; return; } // gate closed: send nothing (like DTX)
      for (; pos < block.length; pos += step) {
        acc[fill++] = block[Math.floor(pos)]!;
        if (fill === FRAME) {
          if (enc.state === "configured") {
            enc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: Math.round((samples / 48000) * 1e6), data: acc }));
          }
          samples += FRAME;
          acc = new Float32Array(FRAME);
          fill = 0;
        }
      }
      pos -= block.length;
    };
    this.mic = { enc, node, src, sink };
  }

  setMicOpen(open: boolean): void {
    this.micOpen = open;
  }

  stopMic(): void {
    const m = this.mic;
    if (!m) return;
    this.mic = null;
    m.node.port.onmessage = null;
    try { m.src.disconnect(); m.node.disconnect(); m.sink.disconnect(); } catch { /* closed */ }
    try { m.enc.close(); } catch { /* closed */ }
  }

  // ---------- camera ----------

  /**
   * Encodes the camera to H.264 (constrained baseline, Annex-B) with WebCodecs and sends one access
   * unit per frame. Frames come from a <video> element via a canvas, which works on iPhone Safari too.
   */
  async startCamera(track: MediaStreamTrack): Promise<void> {
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") throw new Error(t("err.camNoEncoder"));
    const probe = await pickCamConfig(640, 480);
    if (!probe) throw new Error(t("err.camNoEncoder"));
    this.stopCamera();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    await video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d")!;
    const cam: CamSender = { video, canvas, g, enc: null, w: 0, h: 0, timer: 0, forceKey: true, lastKey: 0, sps: null, annexb: probe.annexb, frames: 0 };
    const t0 = performance.now();
    const tick = () => {
      if (this.cam !== cam || video.readyState < 2 || !video.videoWidth) return;
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) return;
      // Fit inside 640 px (long side), even sizes for the encoder.
      const k = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(2, Math.round(video.videoWidth * k) & ~1), h = Math.max(2, Math.round(video.videoHeight * k) & ~1);
      if (!cam.enc || cam.w !== w || cam.h !== h) this.configureCam(cam, w, h);
      const enc = cam.enc;
      if (!enc || enc.state !== "configured") return;
      if (enc.encodeQueueSize > 2 || ws.bufferedAmount > 200_000) { cam.forceKey = true; return; } // behind: drop, restart on a key frame
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      g.drawImage(video, 0, 0, w, h);
      const now = performance.now();
      const frame = new VideoFrame(canvas, { timestamp: Math.round((now - t0) * 1000) });
      const key = cam.forceKey || now - cam.lastKey > 3000; // periodic key frame: late joiners and lost packets recover
      if (key) { cam.forceKey = false; cam.lastKey = now; }
      try { enc.encode(frame, { keyFrame: key }); } catch { cam.forceKey = true; }
      frame.close();
    };
    cam.timer = window.setInterval(tick, 1000 / 20);
    this.cam = cam;
  }

  private configureCam(cam: CamSender, w: number, h: number) {
    try { cam.enc?.close(); } catch { /* closed */ }
    cam.w = w;
    cam.h = h;
    cam.forceKey = true;
    cam.sps = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        const ws = this.ws;
        if (this.cam !== cam || !ws || ws.readyState !== 1) return;
        const raw = new Uint8Array(chunk.byteLength);
        chunk.copyTo(raw);
        const desc = meta?.decoderConfig?.description;
        if (desc) cam.sps = avccParamSets(desc);
        const key = chunk.type === "key";
        const au = cam.annexb ? raw : avccToAnnexB(raw, key ? cam.sps : null);
        const out = new Uint8Array(6 + au.length);
        out[0] = FRAME_CAM;
        out[1] = key ? 1 : 0;
        new DataView(out.buffer).setUint32(2, Math.round(chunk.timestamp * 0.09) >>> 0); // µs -> 90 kHz
        out.set(au, 6);
        ws.send(out);
        cam.frames++;
        this.stats.sentBytes += out.byteLength;
      },
      error: () => { cam.enc = null; }, // reconfigured on the next tick
    });
    enc.configure(camConfig(w, h, cam.annexb));
    cam.enc = enc;
  }

  /** Swap the camera (front/back) without re-creating the producer. */
  setCameraTrack(track: MediaStreamTrack): void {
    const cam = this.cam;
    if (!cam) return;
    cam.video.srcObject = new MediaStream([track]);
    void cam.video.play().catch(() => {});
    cam.forceKey = true;
  }

  stopCamera(): void {
    const cam = this.cam;
    if (!cam) return;
    this.cam = null;
    clearInterval(cam.timer);
    try { cam.enc?.close(); } catch { /* closed */ }
    cam.video.pause();
    cam.video.srcObject = null;
  }

  get cameraFrames(): number {
    return this.cam?.frames ?? 0;
  }
}

interface CamSender {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  enc: VideoEncoder | null;
  w: number;
  h: number;
  timer: number;
  forceKey: boolean;
  lastKey: number;
  /** SPS/PPS from the avcC description, when the encoder only does length-prefixed output. */
  sps: Uint8Array[] | null;
  annexb: boolean;
  frames: number;
}

/** Constrained baseline 3.1 (what the host's tunnel camera producer declares). */
function camConfig(w: number, h: number, annexb: boolean): VideoEncoderConfig {
  return {
    codec: "avc1.42e01f", width: w, height: h, bitrate: 450_000, framerate: 20, latencyMode: "realtime",
    ...(annexb ? { avc: { format: "annexb" } } : {}),
  } as VideoEncoderConfig;
}

async function pickCamConfig(w: number, h: number): Promise<{ annexb: boolean } | null> {
  for (const annexb of [true, false]) {
    try { if ((await VideoEncoder.isConfigSupported(camConfig(w, h, annexb))).supported) return { annexb }; } catch { /* next */ }
  }
  return null;
}

/** SPS and PPS NAL units from an avcC record. */
function avccParamSets(desc: AllowSharedBufferSource): Uint8Array[] {
  const b = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array((desc as ArrayBufferView).buffer, (desc as ArrayBufferView).byteOffset, (desc as ArrayBufferView).byteLength);
  const out: Uint8Array[] = [];
  let i = 5;
  for (const first of [true, false]) {
    const n = first ? b[i++]! & 0x1f : b[i++]!;
    for (let k = 0; k < n && i + 2 <= b.length; k++) {
      const len = (b[i]! << 8) | b[i + 1]!;
      i += 2;
      out.push(b.subarray(i, i + len));
      i += len;
    }
  }
  return out;
}

/** 4-byte length-prefixed NALs -> Annex-B; key frames get SPS/PPS in front. */
function avccToAnnexB(b: Uint8Array, params: Uint8Array[] | null): Uint8Array {
  const parts: Uint8Array[] = [];
  const sc = new Uint8Array([0, 0, 0, 1]);
  for (const p of params ?? []) parts.push(sc, p);
  for (let i = 0; i + 4 <= b.length;) {
    const len = ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    i += 4;
    parts.push(sc, b.subarray(i, i + len));
    i += len;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
