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
  /** A Direct3D exclusive-fullscreen app is running (the overlay cannot show over it). */
  exclusiveFullscreen(): boolean;
  /** Remote control: absolute move to physical virtual-desktop pixels. */
  inputMove(x: number, y: number): boolean;
  /** 0 left, 1 middle, 2 right, 3 back, 4 forward. */
  inputButton(button: number, down: boolean): boolean;
  /** WHEEL_DELTA (120) units; positive dy = up. */
  inputWheel(dx: number, dy: number): boolean;
  /** Virtual-key code press/release (sent with its scan code). */
  inputKey(vk: number, down: boolean): boolean;
  /** Low-level hooks that notice the local user's own input. */
  inputGuardStart(): void;
  inputGuardStop(): void;
  /** ms since the last physical (non-injected) input. */
  physicalIdleMs(): number;
  /** Window frame in physical pixels, null if gone/minimised. */
  windowRect(hwnd: number): Rect | null;
  /** Foreground window handle (0 when none). */
  foregroundWindow(): number;
}

export interface Rect { x: number; y: number; width: number; height: number }

export const native: NativeModule | null;
export const loadError: unknown;
