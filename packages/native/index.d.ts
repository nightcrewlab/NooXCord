export interface LoopbackInfo {
  sampleRate: number;
  channels: number;
}

export interface NativeModule {
  /** Capture system audio, excluding the process tree of excludePid (WASAPI process loopback). */
  loopbackStart(excludePid: number): LoopbackInfo;
  /** Drain captured interleaved float32 PCM. */
  loopbackRead(): Float32Array;
  loopbackStop(): void;
  /** GetAsyncKeyState for a Windows virtual-key code. */
  keyDown(vk: number): boolean;
}

export const native: NativeModule | null;
export const loadError: unknown;
