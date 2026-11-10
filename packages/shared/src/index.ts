export const APP_NAME = "NooXCord";
export const APP_VERSION = "0.1.0";
export const DEFAULT_PORT = 47820;
export const PING_INTERVAL_MS = 2000;
/**
 * Largest client → host text frame sent in one piece (characters, ASCII). Longer frames are split into
 * "~0<chunk>" … "~1<last chunk>" messages so that no TCP segment is near full size: over Hamachi
 * (adapter MTU 1404 on top of e.g. a PPPoE line) full-size segments towards the host vanish, the
 * connection then retransmits the same segment forever and even the pings queue up behind it
 * (host.log 2026-11-07/08: every stall starts at the first ~10 KB "media.consume").
 */
export const PART_SIZE = 900;
export const MAX_FRAME_CHARS = 64 * 1024;

export * from "./models";
export * from "./permissions";
export * from "./protocol";
