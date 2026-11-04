import { Effect, type Scope } from "effect";
import { makeDispatcher } from "./callbacks";
import type { IpcError } from "./errors";
import { MAX_FRAME_BYTES } from "./framing";
import {
  bindDoor,
  makeServerCore,
  type BunSocket,
  type IpcServerApi,
  type IpcServerOptions,
  type RequestHandler,
  type ServerCore,
  type SocketData,
} from "./server";
import { certificateKeyFingerprint, type IpcTlsIdentity } from "./tls";
import {
  acceptKey,
  closePayload,
  encodeFrame,
  FrameDecoder,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
  type WsFrame,
} from "./ws-frames";

/** The one upgrade path of the machine wire, beside the gateway's `/ws`. */
export const IPC_WS_PATH = "/machine";

/** WebSocket-over-TLS listener spec (#1830): the same host identity as the TCP listener. */
export type IpcWsListenSpec = {
  readonly host: string;
  readonly port: number;
  readonly tls: IpcTlsIdentity;
};

export interface IpcWsServer extends IpcServerApi {
  readonly host: string;
  /** The bound port — the real one when the spec asked for port 0. */
  readonly port: number;
}

const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_TOO_BIG = 1009;
const HEAD_END = "\r\n\r\n";
const MAX_HEAD_BYTES = 8192;

interface Transport {
  data: WsDoor | undefined;
  write(data: Buffer | Uint8Array | string): number;
  end(): void;
}

interface TlsTransport extends Transport {
  getPeerCertificate(): { readonly raw?: Buffer } | null;
}

/**
 * One connection: the pinned peer key from the TLS handshake, the HTTP
 * upgrade, then the frame stream. The core sees this object as its byte
 * sink: every NDJSON frame it writes becomes exactly one BINARY message,
 * bytes identical to what the TCP listener writes, queued here so a frame
 * is never split by a partial socket write.
 */
class WsDoor implements BunSocket {
  data: SocketData | undefined;
  readonly decoder = new FrameDecoder(MAX_FRAME_BYTES + 1);
  head = Buffer.alloc(0);
  upgraded = false;
  private queued = Buffer.alloc(0);

  constructor(
    private readonly transport: Transport,
    readonly fingerprint: string,
  ) {}

  write(bytes: Buffer | Uint8Array | string): number {
    this.queued = Buffer.concat([this.queued, encodeFrame(OPCODE_BINARY, Buffer.from(bytes))]);
    this.flush();
    return bytes.length;
  }

  transportWrite(bytes: Buffer | string): void {
    this.transport.write(bytes);
  }

  refuse(response: string): void {
    this.transport.write(response);
    this.transport.end();
  }

  flush(): boolean {
    while (this.queued.length > 0) {
      const written = this.transport.write(this.queued);
      if (written <= 0) return false;
      this.queued = this.queued.subarray(written);
    }
    return true;
  }

  close(code: number, reason: string): void {
    this.transport.write(encodeFrame(OPCODE_CLOSE, closePayload(code, reason)));
    this.transport.end();
  }

  end(): void {
    this.close(1000, "");
  }
}

function upgradeResponse(head: string): string {
  const [requestLine = "", ...lines] = head.split("\r\n");
  const headers = new Map(
    lines.map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()] as const;
    }),
  );
  const [method, target] = requestLine.split(" ");
  if (method !== "GET" || target !== IPC_WS_PATH) return "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
  const key = headers.get("sec-websocket-key");
  if (headers.get("upgrade")?.toLowerCase() !== "websocket" || key === undefined) {
    return "HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n";
  }
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
}

function receiveHead(core: ServerCore, door: WsDoor, chunk: Buffer): void {
  door.head = Buffer.concat([door.head, chunk]);
  const end = door.head.indexOf(HEAD_END);
  if (end < 0) {
    if (door.head.length > MAX_HEAD_BYTES) door.end();
    return;
  }
  const response = upgradeResponse(door.head.subarray(0, end).toString());
  const rest = door.head.subarray(end + HEAD_END.length);
  door.head = Buffer.alloc(0);
  if (!response.startsWith("HTTP/1.1 101")) {
    door.refuse(response);
    return;
  }
  door.transportWrite(response);
  door.upgraded = true;
  core.open(door, door.fingerprint);
  if (rest.length > 0) receiveFrames(core, door, Buffer.from(rest));
}

function receiveFrames(core: ServerCore, door: WsDoor, chunk: Buffer): void {
  const { frames, oversize } = door.decoder.push(chunk);
  for (const frame of frames) {
    if (!deliver(core, door, frame)) return;
  }
  if (oversize) door.close(CLOSE_TOO_BIG, "frame exceeds the machine wire cap");
}

function deliver(core: ServerCore, door: WsDoor, frame: WsFrame): boolean {
  switch (frame.opcode) {
    case OPCODE_BINARY:
      core.handlers.data(door, frame.payload);
      return true;
    case OPCODE_PING:
      door.transportWrite(encodeFrame(OPCODE_PONG, frame.payload));
      return true;
    case OPCODE_PONG:
      return true;
    case OPCODE_CLOSE:
      door.close(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000, "");
      return false;
    default:
      door.close(CLOSE_UNSUPPORTED_DATA, "the machine wire carries binary frames only");
      return false;
  }
}

/**
 * The WebSocket listener (#1830): the SAME TLS termination, peer-key pinning,
 * framing, correlation, limits, backpressure and connection registry as the
 * TLS-TCP listener, behind an HTTP upgrade of `/machine`. Mutual TLS is
 * requested exactly as on the TCP door: a client that presents no
 * certificate never becomes a connection, and the certificate's key
 * fingerprint is handed to the core so `peer_key_mismatch` admission is the
 * same on both network doors. One binary message carries one NDJSON frame.
 */
export function createIpcWsServer(
  spec: IpcWsListenSpec,
  handler: RequestHandler,
  options: IpcServerOptions,
): Effect.Effect<IpcWsServer, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher({ bound: options.dispatcherBound });
    const core = makeServerCore(handler, options, dispatch);
    const door = yield* bindDoor(core, () => Bun.listen<WsDoor | undefined>({
      hostname: spec.host,
      port: spec.port,
      tls: {
        cert: spec.tls.certificate,
        key: spec.tls.privateKey,
        requestCert: true,
        rejectUnauthorized: false,
      },
      socket: {
        handshake(socket: TlsTransport) {
          const raw = socket.getPeerCertificate()?.raw;
          if (raw === undefined) {
            socket.end();
            return;
          }
          socket.data = new WsDoor(socket, certificateKeyFingerprint(raw));
        },
        data(socket: Transport, chunk: Buffer) {
          const door = socket.data;
          if (door === undefined) return;
          if (door.upgraded) receiveFrames(core, door, chunk);
          else receiveHead(core, door, chunk);
        },
        drain(socket: Transport) {
          const door = socket.data;
          if (door?.upgraded && door.flush()) core.handlers.drain(door);
        },
        close(socket: Transport) {
          const door = socket.data;
          if (door?.upgraded) core.handlers.close(door);
        },
      },
    }), (server) => server.stop(true));
    return { host: spec.host, port: door.server.port, ...core.api, close: () => door.close };
  });
}
