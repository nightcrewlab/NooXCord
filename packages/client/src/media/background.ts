/*
 * Phone browsers in a call (mainly iPhone Safari): keep the page alive while it is in the background,
 * and repair audio when it comes back. Best effort — iOS decides in the end:
 *  - Audio Session API (Safari 16.4+): the page is a call (play-and-record), not a muted web page.
 *  - A looping silent <audio> element: a page with playing media is not frozen in the background,
 *    so the WebSocket and the tunnel-mode audio keep running.
 *  - Media Session: lock screen / Control Center shows the channel with a hang-up (where supported).
 *  - Back in front: AudioContexts that iOS interrupted are resumed, a microphone that iOS ended is reopened.
 */
import { audioContext, micContext } from "./level";

type AudioSessionType = "auto" | "playback" | "play-and-record" | "ambient" | "transient" | "transient-solo";
type NavWithSession = Navigator & { audioSession?: { type: AudioSessionType } };

let keepAlive: HTMLAudioElement | null = null;
let keepAliveUrl: string | null = null;
let onVisible: (() => void) | null = null;

/** 1 s of 8 kHz 8-bit mono silence as a WAV blob URL (allowed by the CSP media-src blob:). */
function silenceUrl(): string {
  const n = 8000;
  const b = new ArrayBuffer(44 + n);
  const d = new DataView(b);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); d.setUint32(4, 36 + n, true); str(8, "WAVE");
  str(12, "fmt "); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 8000, true); d.setUint32(28, 8000, true); d.setUint16(32, 1, true); d.setUint16(34, 8, true);
  str(36, "data"); d.setUint32(40, n, true);
  new Uint8Array(b, 44).fill(128);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

export const isMobileWeb = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;

function setSession(type: AudioSessionType): void {
  try {
    const s = (navigator as NavWithSession).audioSession;
    if (s) s.type = type;
  } catch { /* unsupported */ }
}

/**
 * Call inside the join gesture (iOS starts media playback only from a tap).
 * `fixMic` reopens the microphone if iOS stopped it while in the background.
 */
export function startBackgroundCall(channelName: string, actions: { hangup(): void; toggleMic(): void; fixMic(): void }): void {
  if (!isMobileWeb()) return;
  setSession("play-and-record");
  if (!keepAlive) {
    keepAliveUrl = silenceUrl();
    keepAlive = new Audio(keepAliveUrl);
    keepAlive.loop = true;
    keepAlive.setAttribute("playsinline", "");
  }
  void keepAlive.play().catch(() => {});

  const ms = navigator.mediaSession;
  if (ms) {
    try {
      ms.metadata = new MediaMetadata({ title: channelName, artist: "NooXCord" });
      ms.playbackState = "playing";
      const set = (a: string, fn: () => void) => { try { ms.setActionHandler(a as MediaSessionAction, fn); } catch { /* action unknown here */ } };
      set("hangup", actions.hangup);
      set("togglemicrophone", actions.toggleMic);
      // Pausing the silent loop from the lock screen would let iOS freeze the page: keep it going.
      set("pause", () => void keepAlive?.play().catch(() => {}));
      set("play", () => void keepAlive?.play().catch(() => {}));
    } catch { /* no Media Session */ }
  }

  if (!onVisible) {
    onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // iOS leaves contexts "interrupted"/"suspended" after the background: resume (and the loop).
      try { audioContext(); micContext(); } catch { /* closed */ }
      void keepAlive?.play().catch(() => {});
      actions.fixMic();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
  }
}

export function stopBackgroundCall(): void {
  if (onVisible) {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onVisible);
    onVisible = null;
  }
  if (keepAlive) {
    keepAlive.pause();
    keepAlive = null;
  }
  if (keepAliveUrl) {
    URL.revokeObjectURL(keepAliveUrl);
    keepAliveUrl = null;
  }
  const ms = navigator.mediaSession;
  if (ms) {
    try {
      ms.metadata = null;
      ms.playbackState = "none";
      for (const a of ["hangup", "togglemicrophone", "pause", "play"]) {
        try { ms.setActionHandler(a as MediaSessionAction, null); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  setSession("auto");
}
