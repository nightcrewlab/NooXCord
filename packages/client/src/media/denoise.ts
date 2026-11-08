import { micContext } from "./level";

/*
 * Microphone noise suppression (CLAUDE.md §12.3), all on the client so it works the same on desktop,
 * browsers and in tunnel mode:
 *   browser  — Chromium's built-in suppressor (light; getUserMedia noiseSuppression)
 *   rnnoise  — xiph RNNoise (BSD-3) as WASM in an AudioWorklet: removes fans, keyboard, hum
 *   gtcrn    — GTCRN (MIT) neural model, strongest; more CPU
 * Library: @sapphi-red/web-noise-suppressor (MIT). Both models run at the 48 kHz shared context.
 */

export type NoiseMode = "off" | "browser" | "rnnoise" | "gtcrn";

export const NOISE_MODES: NoiseMode[] = ["off", "browser", "rnnoise", "gtcrn"];

/** A processed copy of a microphone track. */
export interface Denoised {
  track: MediaStreamTrack;
  stop(): void;
}

type Lib = typeof import("@sapphi-red/web-noise-suppressor");

let lib: Promise<Lib> | null = null;
const wasm = new Map<string, Promise<ArrayBuffer>>();
const modules = new WeakMap<AudioContext, Set<string>>();

async function assets(mode: "rnnoise" | "gtcrn") {
  // Vite turns these into hashed files next to the app (the CSP allows 'self' + 'wasm-unsafe-eval').
  if (mode === "rnnoise") {
    const [worklet, url, simdUrl] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url"),
      import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url"),
      import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url"),
    ]);
    return { worklet: worklet.default, load: (l: Lib) => l.loadRnnoise({ url: url.default, simdUrl: simdUrl.default }) };
  }
  const [worklet, url] = await Promise.all([
    import("@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url"),
    import("@sapphi-red/web-noise-suppressor/gtcrn.wasm?url"),
  ]);
  return { worklet: worklet.default, load: (l: Lib) => l.loadGtcrn({ url: url.default }) };
}

/** Runs the track through the chosen model; null for "off"/"browser" (nothing to do here). */
export async function denoise(track: MediaStreamTrack, mode: NoiseMode): Promise<Denoised | null> {
  if (mode !== "rnnoise" && mode !== "gtcrn") return null;
  if (typeof AudioWorkletNode === "undefined") return null;
  const c = micContext();
  lib ??= import("@sapphi-red/web-noise-suppressor");
  const l = await lib;
  const a = await assets(mode);
  let bin = wasm.get(mode);
  if (!bin) {
    bin = a.load(l);
    wasm.set(mode, bin);
    bin.catch(() => wasm.delete(mode));
  }
  const binary = await bin;
  const loaded = modules.get(c) ?? new Set<string>();
  modules.set(c, loaded);
  if (!loaded.has(mode)) {
    await c.audioWorklet.addModule(a.worklet);
    loaded.add(mode);
  }
  const node = mode === "rnnoise"
    ? new l.RnnoiseWorkletNode(c, { maxChannels: 1, wasmBinary: binary })
    : new l.GtcrnWorkletNode(c, { maxChannels: 1, wasmBinary: binary });
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const dest = c.createMediaStreamDestination();
  dest.channelCount = 1;
  src.connect(node).connect(dest);
  const out = dest.stream.getAudioTracks()[0]!;
  return {
    track: out,
    stop: () => {
      try { src.disconnect(); node.disconnect(); } catch { /* closed */ }
      (node as { destroy?: () => void }).destroy?.();
      out.stop();
    },
  };
}
