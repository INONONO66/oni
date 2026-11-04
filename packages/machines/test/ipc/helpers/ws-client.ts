import { createHash, randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import type tls from "node:tls";
import type { Effect, Scope } from "effect";
import { connectOverTransport, pinnedTlsDial, type ConnectIpcClientOptions, type IpcClient } from "../../../src/ipc/client";
import { IpcConnectionError, IpcProtocolError, type IpcError } from "../../../src/ipc/errors";
import type { IpcTlsIdentity } from "../../../src/ipc/tls";
import { IPC_WS_PATH } from "../../../src/ipc/ws-server";

/** WebSocket-over-TLS connection spec (#1830): the TCP trust model over an upgraded `/machine`. */
export type IpcWsConnectSpec = {
  readonly ws: { readonly host: string; readonly port: number };
  /** The client identity presented to the host, as for TLS-TCP. */
  readonly tls: IpcTlsIdentity;
  /** PEM of the HOST's certificate: trust anchor and pin, exactly as for TLS-TCP. */
  readonly hostCertificate: string;
};

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const FIN = 0x80;
const MASKED = 0x80;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const LENGTH_16 = 126;
const LENGTH_64 = 127;
const HEAD_END = "\r\n\r\n";

function acceptKey(key: string): string {
  return createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
}

/** One client frame (RFC 6455 §5.2): FIN set, masked, length in its shortest form. */
function clientFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const extended = length < LENGTH_16 ? 0 : length < 65_536 ? 2 : 8;
  const head = Buffer.alloc(2 + extended + 4);
  head[0] = FIN | opcode;
  head[1] = MASKED | (extended === 0 ? length : extended === 2 ? LENGTH_16 : LENGTH_64);
  if (extended === 2) head.writeUInt16BE(length, 2);
  if (extended === 8) head.writeBigUInt64BE(BigInt(length), 2);
  const mask = randomBytes(4);
  mask.copy(head, 2 + extended);
  const body = Buffer.from(payload);
  for (let i = 0; i < length; i += 1) body[i] = (body[i] as number) ^ (mask[i & 3] as number);
  return Buffer.concat([head, body]);
}

/**
 * The NDJSON byte stream over one upgraded WebSocket: every write becomes one
 * masked BINARY message and every binary message the host sends is pushed as
 * the frame bytes the TCP carrier would deliver. Pings are answered, a close
 * is echoed, anything else (text, fragments, masked host frames) is a typed
 * protocol failure. `open` fires once the 101 response carried the expected
 * accept key; the TLS socket's own events (pin failures included) propagate.
 */
class WsFrameStream extends Duplex {
  private buffer: Buffer = Buffer.alloc(0);
  private upgraded = false;
  private readonly key = randomBytes(16).toString("base64");

  constructor(private readonly transport: tls.TLSSocket, host: string) {
    super();
    transport.once("secureConnect", () => {
      transport.write(`GET ${IPC_WS_PATH} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    transport.on("data", (chunk: Buffer) => this.receive(chunk));
    transport.on("error", (error: Error) => this.destroy(error));
    transport.on("close", () => this.destroy());
  }

  override _read(): void {
    // The transport pushes; there is nothing to pull.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.transport.write(clientFrame(OPCODE_BINARY, chunk), callback);
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.transport.destroy();
    callback(error);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let more = this.upgraded || this.completeUpgrade();
    while (more) more = this.readFrame();
  }

  private completeUpgrade(): boolean {
    const end = this.buffer.indexOf(HEAD_END);
    if (end === -1) return false;
    const [status = "", ...headers] = this.buffer.subarray(0, end).toString("latin1").split("\r\n");
    this.buffer = this.buffer.subarray(end + HEAD_END.length);
    const accept = headers.map((line) => line.split(/:\s*/, 2)).find(([name]) => name?.toLowerCase() === "sec-websocket-accept")?.[1];
    if (!status.startsWith("HTTP/1.1 101") || accept !== acceptKey(this.key)) {
      this.destroy(new IpcConnectionError({ message: `websocket upgrade refused: ${status}` }));
      return false;
    }
    this.upgraded = true;
    this.emit("open");
    return true;
  }

  private readFrame(): boolean {
    const head = this.buffer;
    if (head.length < 2) return false;
    const first = head[0] as number;
    const second = head[1] as number;
    let length = second & 0x7f;
    let offset = 2;
    if (length === LENGTH_16) {
      if (head.length < 4) return false;
      length = head.readUInt16BE(2);
      offset = 4;
    } else if (length === LENGTH_64) {
      if (head.length < 10) return false;
      length = Number(head.readBigUInt64BE(2));
      offset = 10;
    }
    if (head.length < offset + length) return false;
    const payload = head.subarray(offset, offset + length);
    this.buffer = head.subarray(offset + length);
    return this.dispatchFrame(first, (second & MASKED) !== 0, payload);
  }

  private dispatchFrame(first: number, masked: boolean, payload: Buffer): boolean {
    const opcode = first & 0x0f;
    const supported = opcode === OPCODE_BINARY || opcode === OPCODE_PING || opcode === OPCODE_PONG || opcode === OPCODE_CLOSE;
    if (masked || (first & FIN) === 0 || !supported) {
      this.destroy(new IpcProtocolError({ message: `unsupported WebSocket frame from the host (first byte 0x${first.toString(16)})` }));
      return false;
    }
    if (opcode === OPCODE_BINARY) this.push(payload);
    if (opcode === OPCODE_PING) this.transport.write(clientFrame(OPCODE_PONG, payload));
    if (opcode === OPCODE_CLOSE) {
      this.transport.end(clientFrame(OPCODE_CLOSE, payload.subarray(0, 2)));
      return false;
    }
    return true;
  }
}

export function connectIpcWsClient(spec: IpcWsConnectSpec, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  const dial = pinnedTlsDial({ ...spec.ws, tls: spec.tls, hostCertificate: spec.hostCertificate });
  return connectOverTransport({
    endpoint: `wss://${spec.ws.host}:${spec.ws.port}${IPC_WS_PATH}`,
    readyEvent: "open",
    start: () => {
      const pinned = dial();
      return { socket: new WsFrameStream(pinned.socket, `${spec.ws.host}:${spec.ws.port}`), classifyError: pinned.classifyError };
    },
  }, opts);
}
