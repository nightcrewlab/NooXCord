import { audioContext } from "./level";

/*
 * Plays raw PCM (interleaved float32) from a MessagePort through an AudioWorklet ring buffer and
 * exposes it as a MediaStreamTrack. Used for desktop system audio (WASAPI process loopback).
 * Ring buffer with ±0.5 % rate correction for clock drift (ADR 0002). Target 120 ms (grows up to 300 ms
 * after late bursts, shrinks back when quiet; counters go to the console as "[audio]"): the PCM comes
 * from the main process in ~10 ms polls whose timing jitters (Windows timers, busy main process); the
 * earlier 70 ms ran dry under load and every refill was an audible click in the stream.
 */
const WORKLET = `
class NxPcm extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.ch = o.channels; this.inRate = o.sampleRate;
    this.cap = Math.ceil(this.inRate * 0.8); // 800 ms
    this.buf = new Float32Array(this.cap * this.ch);
    this.w = 0; this.r = 0; this.fill = 0;
    this.base = this.inRate * 0.12; this.target = this.base; this.max = this.inRate * 0.3;
    this.started = false; this.amp = 1; this.last = [0, 0];
    this.dryAt = -1; this.lastDry = -1e9; this.lastShrink = 0;
    this.underruns = 0; this.skips = 0; this.reported = 0; this.reportAt = 0;
    this.step = this.inRate / sampleRate;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) { e.data.port.onmessage = (m) => this.push(m.data); return; }
      this.push(e.data);
    };
  }
  push(data) {
    const f = data instanceof Float32Array ? data : new Float32Array(data);
    const frames = (f.length / this.ch) | 0;
    // Data again shortly after running dry: that was a late burst, not the end of a sentence (DTX).
    // Adaptive jitter buffer: hold more from now on, so the next late burst does not crackle.
    if (this.dryAt >= 0) {
      if (currentTime - this.dryAt < 0.3) {
        this.underruns++; this.lastDry = currentTime;
        this.target = Math.min(this.max, this.target * 1.25);
      }
      this.dryAt = -1;
    }
    for (let i = 0; i < frames; i++) {
      if (this.fill >= this.cap - 1) { this.r = (this.r + 1) % this.cap; this.fill--; } // overflow: drop oldest
      for (let c = 0; c < this.ch; c++) this.buf[this.w * this.ch + c] = f[i * this.ch + c];
      this.w = (this.w + 1) % this.cap; this.fill++;
    }
  }
  report() {
    // Quiet for 20 s: give back some of the extra delay.
    if (this.target > this.base && currentTime - this.lastDry > 20 && currentTime - this.lastShrink > 20) {
      this.lastShrink = currentTime;
      this.target = Math.max(this.base, this.target * 0.85);
    }
    if (currentTime - this.reportAt < 5) return;
    this.reportAt = currentTime;
    const n = this.underruns + this.skips;
    if (n === this.reported) return;
    this.reported = n;
    this.port.postMessage({ underruns: this.underruns, skips: this.skips, targetMs: Math.round(this.target / this.inRate * 1000) });
  }
  process(_inputs, outputs) {
    const out = outputs[0]; const n = out[0].length;
    this.report();
    if (!this.started) { if (this.fill < this.target) return true; this.started = true; this.pos = 0; this.amp = 0; }
    // Far too much queued (a burst after the producer stalled, e.g. a game hogging the CPU): the slow
    // ±0.5 % correction would take a minute to catch up, heard as a growing delay. Skip to the target.
    if (this.fill > this.target + this.inRate * 0.15) {
      const skip = Math.floor(this.fill - this.target);
      this.r = (this.r + skip) % this.cap; this.fill -= skip; this.amp = 0; this.skips++;
    }
    const drift = (this.fill - this.target) / this.target;
    const step = this.step * (1 + Math.max(-0.005, Math.min(0.005, drift * 0.02)));
    for (let i = 0; i < n; i++) {
      if (this.fill < 2) {
        // Ran dry: fade the last sample out instead of jumping to 0 (a jump is an audible click).
        this.started = false; this.dryAt = currentTime;
        for (let c = 0; c < out.length; c++) { let v = this.last[c] || 0; for (let j = i; j < n; j++) { v *= 0.97; out[c][j] = v; } }
        this.last = [0, 0];
        return true;
      }
      const a = this.r, b = (this.r + 1) % this.cap, t = this.pos;
      for (let c = 0; c < out.length; c++) {
        const sc = Math.min(c, this.ch - 1);
        const v = (this.buf[a * this.ch + sc] * (1 - t) + this.buf[b * this.ch + sc] * t) * this.amp;
        out[c][i] = v; this.last[c] = v;
      }
      if (this.amp < 1) this.amp = Math.min(1, this.amp + 1 / 240); // 5 ms fade-in after a (re)start
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

/**
 * The ring-buffer player as an audio node on the shared context. Tunnel audio connects it straight to
 * the speakers: a MediaStream round trip (destination -> track -> source) adds a second FIFO that
 * under/overruns under load and was heard as a constant scratchy crackle in tunnel mode.
 */
export async function pcmNode(port: MessagePort, sampleRate: number, channels: number, label = "pcm"): Promise<AudioWorkletNode> {
  const c = audioContext();
  loaded ??= (async () => {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  })();
  await loaded;
  const node = new AudioWorkletNode(c, "nx-pcm", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { sampleRate, channels } });
  node.port.postMessage({ port }, [port]);
  node.port.onmessage = (e: MessageEvent<{ underruns: number; skips: number; targetMs: number }>) =>
    console.warn(`[audio] ${label}: buffer ran dry ${e.data.underruns}x, skipped ${e.data.skips}x, now holds ${e.data.targetMs} ms`);
  return node;
}

export async function pcmTrack(port: MessagePort, sampleRate: number, channels: number): Promise<PcmTrack> {
  const c = audioContext();
  const node = await pcmNode(port, sampleRate, channels, "system audio");
  const dest = c.createMediaStreamDestination();
  node.connect(dest);
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
