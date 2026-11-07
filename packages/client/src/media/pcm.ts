import { audioContext } from "./level";

/*
 * Plays raw PCM (interleaved float32) from a MessagePort through an AudioWorklet ring buffer and
 * exposes it as a MediaStreamTrack. Used for desktop system audio (WASAPI process loopback).
 * ADR 0002 rule: ring buffer with a 60–80 ms target and ±0.5 % rate correction for clock drift.
 */
const WORKLET = `
class NxPcm extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.ch = o.channels; this.inRate = o.sampleRate;
    this.cap = Math.ceil(this.inRate * 0.5); // 500 ms
    this.buf = new Float32Array(this.cap * this.ch);
    this.w = 0; this.r = 0; this.fill = 0;
    this.target = this.inRate * 0.07; this.started = false;
    this.step = this.inRate / sampleRate;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) { e.data.port.onmessage = (m) => this.push(m.data); return; }
      this.push(e.data);
    };
  }
  push(data) {
    const f = data instanceof Float32Array ? data : new Float32Array(data);
    const frames = (f.length / this.ch) | 0;
    for (let i = 0; i < frames; i++) {
      if (this.fill >= this.cap - 1) { this.r = (this.r + 1) % this.cap; this.fill--; } // overflow: drop oldest
      for (let c = 0; c < this.ch; c++) this.buf[this.w * this.ch + c] = f[i * this.ch + c];
      this.w = (this.w + 1) % this.cap; this.fill++;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0]; const n = out[0].length;
    if (!this.started) { if (this.fill < this.target) return true; this.started = true; this.pos = 0; }
    const drift = (this.fill - this.target) / this.target;
    const step = this.step * (1 + Math.max(-0.005, Math.min(0.005, drift * 0.01)));
    for (let i = 0; i < n; i++) {
      if (this.fill < 2) { this.started = false; for (const o of out) o.fill(0, i); return true; }
      const a = this.r, b = (this.r + 1) % this.cap, t = this.pos;
      for (let c = 0; c < out.length; c++) {
        const sc = Math.min(c, this.ch - 1);
        out[c][i] = this.buf[a * this.ch + sc] * (1 - t) + this.buf[b * this.ch + sc] * t;
      }
      this.pos += step;
      while (this.pos >= 1) { this.pos -= 1; this.r = b; this.fill--; }
    }
    return true;
  }
}
registerProcessor("nx-pcm", NxPcm);
`;

let loaded: Promise<void> | null = null;

export interface PcmTrack {
  track: MediaStreamTrack;
  stop(): void;
}

export async function pcmTrack(port: MessagePort, sampleRate: number, channels: number): Promise<PcmTrack> {
  const c = audioContext();
  loaded ??= (async () => {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  })();
  await loaded;
  const node = new AudioWorkletNode(c, "nx-pcm", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { sampleRate, channels } });
  const dest = c.createMediaStreamDestination();
  node.connect(dest);
  node.port.postMessage({ port }, [port]);
  const track = dest.stream.getAudioTracks()[0]!;
  return {
    track,
    stop() {
      track.stop();
      try { node.disconnect(); } catch { /* already */ }
      port.close();
    },
  };
}
