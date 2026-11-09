import { create } from "zustand";
import type { StreamPreset } from "@nooxcord/shared";
import type { NoiseMode } from "./denoise";

/** Per-device voice preferences, kept in localStorage. */
export interface VoiceSettings {
  inputDeviceId: string; // "" = system default
  outputDeviceId: string;
  cameraDeviceId: string; // "" = default / front camera
  mode: "vad" | "ptt";
  /** KeyboardEvent.code for push-to-talk. */
  pttKey: string;
  /** Shortcut that toggles the microphone while in voice ("Ctrl+Shift+KeyM", "F9", "Mouse4"); null = none. */
  muteKey: string | null;
  /** Voice activity threshold in dBFS; null = automatic (follows the noise floor). */
  vadThreshold: number | null;
  echoCancellation: boolean;
  /** Kept for old saves; noiseMode decides. */
  noiseSuppression: boolean;
  /** Microphone noise suppression: browser built-in, RNNoise or GTCRN (media/denoise.ts). */
  noiseMode: NoiseMode;
  autoGainControl: boolean;
  /** Per-user playback volume 0–2 (1 = 100 %). */
  volumes: Record<string, number>;
  streamPreset: StreamPreset;
  contentHint: "motion" | "detail";
  streamAudio: boolean;
  /** Tunnel-mode viewers of my stream get the full quality layer (else the small one). */
  streamTunnelHigh: boolean;
  /** Theater view (watching a stream): the participant strip under it is collapsed. */
  stripHidden: boolean;
  overlay: boolean;
  /** Tones when people join / leave my voice channel or mute / deafen. */
  voiceSounds: boolean;
}

const KEY = "nx.voice";
const defaults: VoiceSettings = {
  inputDeviceId: "",
  outputDeviceId: "",
  cameraDeviceId: "",
  mode: "vad",
  pttKey: "KeyV",
  muteKey: null,
  vadThreshold: null,
  echoCancellation: true,
  noiseSuppression: true,
  noiseMode: "rnnoise",
  autoGainControl: true,
  volumes: {},
  streamPreset: "standard",
  contentHint: "motion",
  streamAudio: true,
  streamTunnelHigh: false,
  stripHidden: false,
  overlay: true,
  voiceSounds: true,
};

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<VoiceSettings>;
    // Saves from before noiseMode: a switched-off suppressor stays off.
    if (!saved.noiseMode && saved.noiseSuppression === false) saved.noiseMode = "off";
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export const useVoiceSettings = create<VoiceSettings & { set(p: Partial<VoiceSettings>): void }>()((set, get) => ({
  ...load(),
  set(p) {
    set(p);
    const { set: _omit, ...rest } = get();
    void _omit;
    try { localStorage.setItem(KEY, JSON.stringify(rest)); } catch { /* storage blocked */ }
  },
}));

export const voiceSettings = (): VoiceSettings => useVoiceSettings.getState();
