import { createHash } from "node:crypto";

/** RFC 6455 framing shared by the ws listener and its test client. */
const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const FIN = 0x80;
const MASKED = 0x80;
const LENGTH_16 = 126;
const LENGTH_64 = 127;
const MASK_BYTES = 4;

export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export type WsFrame = { readonly opcode: number; readonly payload: Buffer };

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
}

/** One FIN frame; a client frame is masked with `mask` (4 bytes), a server frame is not. */
export function encodeFrame(opcode: number, payload: Uint8Array, mask?: Buffer): Buffer {
  const length = payload.length;
  const extended = length >= 65_536 ? 8 : length >= LENGTH_16 ? 2 : 0;
  const head = Buffer.alloc(2 + extended + (mask ? MASK_BYTES : 0));
  head[0] = FIN | opcode;
  const flag = mask ? MASKED : 0;
  if (extended === 8) {
    head[1] = flag | LENGTH_64;
    head.writeBigUInt64BE(BigInt(length), 2);
  } else if (extended === 2) {
    head[1] = flag | LENGTH_16;
    head.writeUInt16BE(length, 2);
  } else {
    head[1] = flag | length;
  }
  if (!mask) return Buffer.concat([head, payload]);
  mask.copy(head, 2 + extended);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = (body[i] as number) ^ (mask[i % MASK_BYTES] as number);
  return Buffer.concat([head, body]);
}

export function closePayload(code: number, reason: string): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(code, 0);
  return Buffer.concat([head, Buffer.from(reason)]);
}

/**
 * Accumulates bytes and yields complete frames. A payload over `cap` bytes
 * is reported as `oversize` so the door can close with 1009 before buffering it.
 */
export class FrameDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly cap: number) {}

  push(bytes: Buffer): { frames: WsFrame[]; oversize: boolean } {
    this.pending = this.pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.pending, bytes]);
    const frames: WsFrame[] = [];
    for (;;) {
      const parsed = this.next();
      if (parsed === "incomplete") return { frames, oversize: false };
      if (parsed === "oversize") return { frames, oversize: true };
      frames.push(parsed);
    }
  }

  private next(): WsFrame | "incomplete" | "oversize" {
    const buf = this.pending;
    if (buf.length < 2) return "incomplete";
    const masked = ((buf[1] as number) & MASKED) !== 0;
    let length = (buf[1] as number) & 0x7f;
    let offset = 2;
    if (length === LENGTH_16) {
      if (buf.length < 4) return "incomplete";
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === LENGTH_64) {
      if (buf.length < 10) return "incomplete";
      const wide = buf.readBigUInt64BE(2);
      if (wide > BigInt(this.cap)) return "oversize";
      length = Number(wide);
      offset = 10;
    }
    if (length > this.cap) return "oversize";
    const maskAt = offset;
    if (masked) offset += MASK_BYTES;
    if (buf.length < offset + length) return "incomplete";
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (buf[maskAt + (i % MASK_BYTES)] as number);
    }
    this.pending = buf.subarray(offset + length);
    return { opcode: (buf[0] as number) & 0x0f, payload };
  }
}
