/*
 * Microphone level meter on the audio thread (AudioWorklet), so voice activity detection keeps
 * working while the window is hidden and timers are throttled (e.g. during a game).
 */
const WORKLET = `
class NxLevel extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.n = 0; this.peak = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) { const v = ch[i]; this.sum += v * v; const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a; }
      this.n += ch.length;
    }
    if (this.n >= 2048) { // ~43 ms at 48 kHz
      const rms = Math.sqrt(this.sum / this.n);
      this.port.postMessage(20 * Math.log10(Math.max(rms, 1e-8)));
      this.sum = 0; this.n = 0; this.peak = 0;
    }
    return true;
  }
}
registerProcessor("nx-level", NxLevel);
`;

let ctx: AudioContext | null = null;
let moduleReady: Promise<void> | null = null;

/** Shared AudioContext. Create it inside a user gesture the first time (iOS). */
export function audioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 }); // 48 kHz: Opus in tunnel mode
    moduleReady = null;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

async function ensureModule(c: AudioContext): Promise<void> {
  moduleReady ??= (async () => {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await c.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  return moduleReady;
}

export interface LevelMeter {
  stop(): void;
}

/** Calls onLevel(dBFS) about 23 times per second for the given track. */
export async function meter(track: MediaStreamTrack, onLevel: (db: number) => void): Promise<LevelMeter> {
  const c = audioContext();
  await ensureModule(c);
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(c, "nx-level", { numberOfOutputs: 0 });
  node.port.onmessage = (e) => onLevel(e.data as number);
  src.connect(node);
  return {
    stop() {
      node.port.onmessage = null;
      try { src.disconnect(); } catch { /* already */ }
    },
  };
}

/**
 * Voice activity gate with hang time. Automatic mode tracks the noise floor and opens
 * ~14 dB above it (never below -62 dB).
 */
export class VadGate {
  private floor = -70;
  private openUntil = 0;
  open = false;

  update(db: number, threshold: number | null, now = performance.now()): boolean {
    // Noise floor: fall fast, rise slowly.
    this.floor = db < this.floor ? db : this.floor + (db - this.floor) * 0.01;
    const th = threshold ?? Math.max(-62, Math.min(-30, this.floor + 14));
    if (db > th) this.openUntil = now + 320;
    this.open = now < this.openUntil;
    return this.open;
  }

  get autoThreshold(): number {
    return Math.max(-62, Math.min(-30, this.floor + 14));
  }
}
