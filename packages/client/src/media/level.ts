/*
 * Microphone level meter on the audio thread (AudioWorklet), so voice activity detection keeps
 * working while the window is hidden and timers are throttled (e.g. during a game).
 */
const WORKLET = `
class NxLevel extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.n = 0; this.peak = 0; this.afterSound = false; this.run = 0; this.holes = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let any = false;
      for (let i = 0; i < ch.length; i++) { const v = ch[i]; if (v !== 0) any = true; this.sum += v * v; const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a; }
      this.n += ch.length;
      // A dropout: 1-4 exactly-silent blocks (≤ 11 ms) between blocks with sound. Real audio never does
      // this; a starved/overflowing capture FIFO does (heard as crackle).
      if (any) {
        if (this.run > 0 && this.run <= 4) this.holes++;
        this.run = 0; this.afterSound = true;
      } else if (this.afterSound && ++this.run > 4) {
        this.run = 0; this.afterSound = false;
      }
    }
    if (this.n >= 2048) { // ~43 ms at 48 kHz
      const rms = Math.sqrt(this.sum / this.n);
      this.port.postMessage({ db: 20 * Math.log10(Math.max(rms, 1e-8)), holes: this.holes });
      this.sum = 0; this.n = 0; this.peak = 0; this.holes = 0;
    }
    return true;
  }
}
registerProcessor("nx-level", NxLevel);
`;

let ctx: AudioContext | null = null;
let mic: AudioContext | null = null;
const moduleReady = new WeakMap<AudioContext, Promise<void>>();

/** Shared AudioContext (playback, stream audio, tunnel media). Create it inside a user gesture the first time (iOS). */
export function audioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 }); // 48 kHz: Opus in tunnel mode
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/**
 * The microphone's own AudioContext (noise suppression model + level meter). Kept apart from the
 * shared one so stream audio / tunnel decoding can never starve the mic path, and so the mic path can
 * be rebuilt without touching playback. Create it inside a user gesture the first time (iOS).
 */
export function micContext(): AudioContext {
  if (!mic || mic.state === "closed") mic = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 }); // RNNoise/GTCRN need 48 kHz
  if (mic.state === "suspended") void mic.resume();
  return mic;
}

/** Nothing uses the microphone any more: let its audio thread sleep (idle CPU ~0). */
export function idleMicContext(): void {
  if (mic && mic.state === "running") void mic.suspend();
}

async function ensureModule(c: AudioContext): Promise<void> {
  let p = moduleReady.get(c);
  if (!p) {
    p = (async () => {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await c.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    moduleReady.set(c, p);
  }
  return p;
}

export interface LevelMeter {
  stop(): void;
}

/**
 * Calls onLevel(dBFS) about 23 times per second for the given track (on the microphone context).
 * onHoles gets the number of audio dropouts seen in that window (see the worklet).
 */
export async function meter(track: MediaStreamTrack, onLevel: (db: number) => void, onHoles?: (n: number) => void): Promise<LevelMeter> {
  const c = micContext();
  await ensureModule(c);
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(c, "nx-level", { numberOfOutputs: 0 });
  node.port.onmessage = (e) => {
    const m = e.data as { db: number; holes: number };
    onLevel(m.db);
    if (m.holes && onHoles) onHoles(m.holes);
  };
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
