import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { IpcProtocolError } from "./errors";
import { MAX_FRAME_BYTES } from "./framing";

/**
 * Post-handshake frame sealing (#1832). Once the signed handshake derived a
 * session key, every NDJSON frame travels as ONE base64 line of
 * `nonce || ciphertext || tag` under AES-256-GCM: the newline framing of the
 * TCP door, the one-message-per-frame rule of the WebSocket door and the
 * Rust peer's line reader all keep one line per frame while a relay, CDN or
 * proxy that terminated TLS sees only ciphertext. The nonce is the
 * per-direction frame counter and the receiver insists on the exact next
 * one, so a replayed, dropped or reordered frame ends the connection.
 */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** A sealed line carrying the largest admissible plaintext frame. */
const MAX_SEALED_LINE_CHARS = Math.ceil((MAX_FRAME_BYTES + NONCE_BYTES + TAG_BYTES) / 3) * 4;

/** The HKDF inputs both peers agree on: the shared secret, the transcript hash and the protocol labels. */
export type SealSchedule = {
  readonly sharedSecret: Uint8Array;
  readonly salt: Uint8Array;
  readonly info: string;
  /** Associated data of frames the initiator sends. */
  readonly initiatorAad: string;
  /** Associated data of frames the responder sends. */
  readonly responderAad: string;
};

export type SealKeys = {
  readonly send: Buffer;
  readonly receive: Buffer;
  readonly sendAad: Buffer;
  readonly receiveAad: Buffer;
};

/**
 * The two directional keys of one session: the initiator sends under the
 * first half of the HKDF output and the responder under the second, so the
 * same schedule yields mirror-image keys on both ends.
 */
export function deriveSealKeys(schedule: SealSchedule, role: "initiator" | "responder"): SealKeys {
  const okm = Buffer.from(hkdfSync("sha256", schedule.sharedSecret, schedule.salt, schedule.info, KEY_BYTES * 2));
  const initiatorKey = okm.subarray(0, KEY_BYTES);
  const responderKey = okm.subarray(KEY_BYTES);
  return role === "initiator"
    ? { send: initiatorKey, receive: responderKey, sendAad: Buffer.from(schedule.initiatorAad), receiveAad: Buffer.from(schedule.responderAad) }
    : { send: responderKey, receive: initiatorKey, sendAad: Buffer.from(schedule.responderAad), receiveAad: Buffer.from(schedule.initiatorAad) };
}

function nonceOf(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, NONCE_BYTES - 8);
  return nonce;
}

export class FrameSeal {
  private sendCounter = 0n;
  private receiveCounter = 0n;

  constructor(private readonly keys: SealKeys) {}

  /** One plaintext frame, trailing newline included, becomes one sealed line. */
  seal(frame: Uint8Array): Uint8Array {
    const nonce = nonceOf(this.sendCounter);
    this.sendCounter += 1n;
    const cipher = createCipheriv("aes-256-gcm", this.keys.send, nonce);
    cipher.setAAD(this.keys.sendAad);
    const body = Buffer.concat([nonce, cipher.update(frame), cipher.final(), cipher.getAuthTag()]);
    return Buffer.from(`${body.toString("base64")}\n`);
  }

  /** One sealed line, without its newline, back to the plaintext frame bytes. */
  open(line: string): Uint8Array {
    const body = Buffer.from(line, "base64");
    if (body.length < NONCE_BYTES + TAG_BYTES || body.toString("base64") !== line) {
      throw new IpcProtocolError({ message: "sealed frame is not the base64 of nonce, ciphertext and tag" });
    }
    const nonce = body.subarray(0, NONCE_BYTES);
    if (nonce.readUInt32BE(0) !== 0 || nonce.readBigUInt64BE(NONCE_BYTES - 8) !== this.receiveCounter) {
      throw new IpcProtocolError({ message: "sealed frame counter is out of order" });
    }
    const decipher = createDecipheriv("aes-256-gcm", this.keys.receive, nonce);
    decipher.setAAD(this.keys.receiveAad);
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    let frame: Buffer;
    try {
      frame = Buffer.concat([decipher.update(body.subarray(NONCE_BYTES, body.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new IpcProtocolError({ message: "sealed frame failed authentication" });
    }
    this.receiveCounter += 1n;
    return frame;
  }
}

/**
 * Splits a sealed byte stream into lines and opens each one. A line that
 * fails to open throws, and the caller ends the connection: unlike a
 * malformed plaintext line there is no honest way to produce one.
 */
export class SealedDecoder {
  private buffer = "";

  constructor(private readonly seal: FrameSeal) {}

  push(chunk: Uint8Array | string): Uint8Array[] {
    this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_SEALED_LINE_CHARS) {
      this.buffer = "";
      throw new IpcProtocolError({ message: `sealed frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes` });
    }
    const frames: Uint8Array[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      frames.push(this.seal.open(line));
    }
    return frames;
  }
}
