import { randomBytes } from "node:crypto";
import tls from "node:tls";
import { HOST_PINNED, pinnedTlsDial, type PinnedTlsTarget } from "../../../src/ipc/client";
import { encodeFrame, FrameDecoder, OPCODE_BINARY, OPCODE_CLOSE } from "../../../src/ipc/ws-frames";
import { IPC_WS_PATH } from "../../../src/ipc/ws-server";
import { deferred } from "./signal";
import { unverifiedTlsOptions } from "./tls-fixtures";

const HEAD_END = "\r\n\r\n";
export const OPCODE_TEXT = 0x1;

export interface RawWs {
  readonly opened: Promise<string>;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly ended: Promise<{ received: number }>;
  readonly messages: Buffer[];
  send(opcode: typeof OPCODE_BINARY | typeof OPCODE_TEXT, payload: Buffer | string): void;
  nextMessage(): Promise<Buffer>;
  destroy(): void;
}

/** A raw RFC 6455 client over the pinned mutual-TLS dial, or over a bare unverified TLS dial (no client identity, no pin) when `tls` is omitted. */
export function rawWs(target: Omit<PinnedTlsTarget, "tls"> & { tls?: PinnedTlsTarget["tls"] }, path = IPC_WS_PATH, upgrade = true): RawWs {
  const ready = target.tls ? HOST_PINNED : "secureConnect";
  const socket = target.tls
    ? pinnedTlsDial({ ...target, tls: target.tls })().socket
    : tls.connect({ host: target.host, port: target.port, ...unverifiedTlsOptions() });
  const opened = deferred<string>();
  const closed = deferred<{ code: number; reason: string }>();
  const ended = deferred<{ received: number }>();
  const waiting: Array<(message: Buffer) => void> = [];
  const messages: Buffer[] = [];
  const decoder = new FrameDecoder(64 * 1024 * 1024);
  let head = "";
  let upgraded = false;
  let received = 0;
  socket.once(ready, () => {
    const upgradeHeaders = upgrade
      ? `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n`
      : "";
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\n${upgradeHeaders}\r\n`);
  });
  socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
    let frames = chunk;
    if (!upgraded) {
      head += chunk.toString("latin1");
      const end = head.indexOf(HEAD_END);
      if (end < 0) return;
      upgraded = true;
      opened.resolve(head.slice(0, end).split("\r\n")[0] ?? "");
      frames = Buffer.from(head.slice(end + HEAD_END.length), "latin1");
    }
    for (const frame of decoder.push(frames).frames) {
      if (frame.opcode === OPCODE_CLOSE) {
        closed.resolve({ code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString() });
      } else if (frame.opcode === OPCODE_BINARY) {
        const next = waiting.shift();
        if (next) next(frame.payload);
        else messages.push(frame.payload);
      }
    }
  });
  socket.once("close", () => ended.resolve({ received }));
  socket.once("error", () => undefined);
  return {
    opened: opened.promise,
    closed: closed.promise,
    ended: ended.promise,
    messages,
    send: (opcode, payload) => {
      socket.write(encodeFrame(opcode, Buffer.from(payload), randomBytes(4)));
    },
    nextMessage: () => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiting.push(resolve));
    },
    destroy: () => socket.destroy(),
  };
}
