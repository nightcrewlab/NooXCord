/*
 * RTP helpers for the tunnel media path (NXM-WS, CLAUDE.md §2.3 way 3). mediasoup DirectTransport
 * consumers hand us RTP packets; we turn them into whole frames for WebCodecs on the client:
 *   audio: Opus payload as-is
 *   video: H.264 access unit in Annex-B, or a VP8 frame
 *
 * Frames on the /media socket (server -> client), big endian:
 *   [0]=1 audio | [1..2] tag | [3..6] rtp timestamp | opus
 *   [0]=2 video | [1..2] tag | [3] flags (1 key, 2 vp8) | [4..7] rtp timestamp | data
 *   [0]=5 key   | (send a camera key frame now)
 * Client -> server:
 *   [0]=3 mic   | opus (20 ms, 48 kHz)
 *   [0]=4 cam   | [1] flags (1 key) | [2..5] timestamp (90 kHz) | H.264 access unit, Annex-B
 */

export const FRAME_AUDIO = 1;
export const FRAME_VIDEO = 2;
export const FRAME_MIC = 3;
export const FRAME_CAM = 4;
export const FRAME_KEYREQ = 5;
/** Tunnel-mode screen share: same layout as FRAME_CAM. */
export const FRAME_SCREEN = 6;

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
export function buildRtp(payloadType: number, seq: number, timestamp: number, ssrc: number, payload: Buffer, marker = false): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (payloadType & 0x7f) | (marker ? 0x80 : 0);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(timestamp >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([h, payload]);
}

const START = Buffer.from([0, 0, 0, 1]);

/** NAL units of an Annex-B buffer (3- or 4-byte start codes). */
export function splitAnnexB(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < b.length) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && b[end - 1] === 0) end--; // trailing zero of a 4-byte start code
        if (end > start) out.push(b.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < b.length) out.push(b.subarray(start));
  return out;
}

/** RFC 6184 payloads for one access unit: single NAL packets, FU-A for big NALs. */
export function packetizeH264(annexB: Buffer, maxPayload = 1150): Buffer[] {
  const out: Buffer[] = [];
  for (const nal of splitAnnexB(annexB)) {
    if (nal.length === 0) continue;
    const type = nal[0]! & 0x1f;
    if (type === 9) continue; // access unit delimiter
    if (nal.length <= maxPayload) { out.push(nal); continue; }
    const ind = (nal[0]! & 0xe0) | 28;
    let off = 1;
    while (off < nal.length) {
      const n = Math.min(maxPayload - 2, nal.length - off);
      const first = off === 1, last = off + n >= nal.length;
      out.push(Buffer.concat([Buffer.from([ind, (first ? 0x80 : 0) | (last ? 0x40 : 0) | type]), nal.subarray(off, off + n)]));
      off += n;
    }
  }
  return out;
}

/** Does a compound RTCP packet ask for a key frame (PLI or FIR)? */
/** Media SSRCs that a compound RTCP packet asks key frames for (PLI / FIR). */
export function keyFrameSsrcs(b: Buffer): number[] {
  const out: number[] = [];
  let i = 0;
  while (i + 4 <= b.length) {
    const fmt = b[i]! & 0x1f, pt = b[i + 1]!;
    const next = i + (b.readUInt16BE(i + 2) + 1) * 4;
    if (pt === 206 && fmt === 1 && i + 12 <= b.length) out.push(b.readUInt32BE(i + 8));
    if (pt === 206 && fmt === 4) for (let j = i + 12; j + 8 <= Math.min(next, b.length); j += 8) out.push(b.readUInt32BE(j));
    i = next;
  }
  return out;
}

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
