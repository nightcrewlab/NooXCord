/*
 * RTP helpers for the tunnel media path (NXM-WS, CLAUDE.md §2.3 way 3). mediasoup DirectTransport
 * consumers hand us RTP packets; we turn them into whole frames for WebCodecs on the client:
 *   audio: Opus payload as-is
 *   video: H.264 access unit in Annex-B, or a VP8 frame
 *
 * Frames on the /media socket (server -> client), big endian:
 *   [0]=1 audio | [1..2] tag | [3..6] rtp timestamp | opus
 *   [0]=2 video | [1..2] tag | [3] flags (1 key, 2 vp8) | [4..7] rtp timestamp | data
 * Client -> server:
 *   [0]=3 mic   | opus (20 ms, 48 kHz)
 */

export const FRAME_AUDIO = 1;
export const FRAME_VIDEO = 2;
export const FRAME_MIC = 3;

export interface RtpPacket {
  marker: boolean;
  payloadType: number;
  seq: number;
  timestamp: number;
  payload: Buffer;
}

export function parseRtp(b: Buffer): RtpPacket | null {
  if (b.length < 12 || b[0]! >> 6 !== 2) return null;
  const cc = b[0]! & 0x0f;
  let off = 12 + cc * 4;
  if (b[0]! & 0x10) {
    if (b.length < off + 4) return null;
    off += 4 + b.readUInt16BE(off + 2) * 4;
  }
  let end = b.length;
  if (b[0]! & 0x20) end -= b[b.length - 1]!;
  if (off > end) return null;
  return { marker: (b[1]! & 0x80) !== 0, payloadType: b[1]! & 0x7f, seq: b.readUInt16BE(2), timestamp: b.readUInt32BE(4), payload: b.subarray(off, end) };
}

/** Minimal RTP packet for an Opus frame coming from a tunnel-mode microphone. */
export function buildRtp(payloadType: number, seq: number, timestamp: number, ssrc: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = payloadType & 0x7f;
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(timestamp >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([h, payload]);
}

const START = Buffer.from([0, 0, 0, 1]);

export interface VideoFrame {
  key: boolean;
  timestamp: number;
  data: Buffer;
}

/** Rebuilds whole frames from RTP. A lost packet drops the frame and asks for a key frame. */
export class FrameAssembler {
  private parts: Buffer[] = [];
  private ts = -1;
  private lastSeq = -1;
  private broken = false;
  private key = false;
  private waitKey = true;

  constructor(private codec: "h264" | "vp8", private onFrame: (f: VideoFrame) => void, private needKey: () => void) {}

  push(p: RtpPacket): void {
    if (p.timestamp !== this.ts) {
      this.reset(p.timestamp); // previous frame never got its marker: drop it
    } else if (this.lastSeq >= 0 && ((this.lastSeq + 1) & 0xffff) !== p.seq) {
      this.broken = true;
    }
    this.lastSeq = p.seq;
    if (this.codec === "h264") this.h264(p.payload);
    else this.vp8(p.payload);
    if (!p.marker) return;
    if (this.broken || this.parts.length === 0) {
      this.waitKey = true;
      this.needKey();
    } else if (!this.waitKey || this.key) {
      this.waitKey = false;
      this.onFrame({ key: this.key, timestamp: p.timestamp, data: Buffer.concat(this.parts) });
    } else {
      this.needKey();
    }
    this.reset(-1);
  }

  /** The socket fell behind: skip until the next key frame. */
  skipToKey(): void {
    this.waitKey = true;
  }

  private reset(ts: number) {
    this.parts = [];
    this.ts = ts;
    this.broken = false;
    this.key = false;
    if (ts === -1) this.lastSeq = -1;
  }

  private h264(p: Buffer) {
    if (p.length < 1) return;
    const type = p[0]! & 0x1f;
    if (type >= 1 && type <= 23) {
      if (type === 5) this.key = true;
      this.parts.push(START, p);
    } else if (type === 24) {
      // STAP-A: [hdr][size16][nal]...
      let i = 1;
      while (i + 2 <= p.length) {
        const n = p.readUInt16BE(i);
        i += 2;
        if (n === 0 || i + n > p.length) break;
        const nal = p.subarray(i, i + n);
        if ((nal[0]! & 0x1f) === 5) this.key = true;
        this.parts.push(START, nal);
        i += n;
      }
    } else if (type === 28 && p.length > 2) {
      // FU-A
      const fu = p[1]!;
      const nalType = fu & 0x1f;
      if (fu & 0x80) {
        if (nalType === 5) this.key = true;
        this.parts.push(START, Buffer.from([(p[0]! & 0xe0) | nalType]), p.subarray(2));
      } else if (this.parts.length > 0) {
        this.parts.push(p.subarray(2));
      } else {
        this.broken = true;
      }
    }
  }

  private vp8(p: Buffer) {
    if (p.length < 1) return;
    const b0 = p[0]!;
    let i = 1;
    if (b0 & 0x80) {
      const x = p[i++]!;
      if (x & 0x80) i += p[i]! & 0x80 ? 2 : 1; // picture id
      if (x & 0x40) i++; // tl0picidx
      if (x & 0x30) i++; // tid / keyidx
    }
    if (i >= p.length) return;
    const start = (b0 & 0x10) !== 0 && (b0 & 0x0f) === 0;
    if (start) {
      if (this.parts.length > 0) this.broken = true;
      this.key = (p[i]! & 0x01) === 0;
    } else if (this.parts.length === 0) {
      this.broken = true;
    }
    this.parts.push(p.subarray(i));
  }
}

export function audioFrame(tag: number, timestamp: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(7);
  h[0] = FRAME_AUDIO;
  h.writeUInt16BE(tag, 1);
  h.writeUInt32BE(timestamp >>> 0, 3);
  return Buffer.concat([h, payload]);
}

export function videoFrame(tag: number, f: VideoFrame, vp8: boolean): Buffer {
  const h = Buffer.alloc(8);
  h[0] = FRAME_VIDEO;
  h.writeUInt16BE(tag, 1);
  h[3] = (f.key ? 1 : 0) | (vp8 ? 2 : 0);
  h.writeUInt32BE(f.timestamp >>> 0, 4);
  return Buffer.concat([h, f.data]);
}
