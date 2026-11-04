import type { ServerWebSocket } from "bun";
import { Effect, type Scope } from "effect";
import { makeDispatcher } from "./callbacks";
import type { IpcError } from "./errors";
import { MAX_FRAME_BYTES } from "./framing";
import { bindDoor, makeServerCore, type BunSocket, type IpcServerApi, type IpcServerOptions, type RequestHandler, type SocketData } from "./server";
import type { IpcTlsIdentity } from "./tls";

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

/** WebSocket close code for a text frame: the machine wire is binary only. */
const UNSUPPORTED_DATA = 1003;

/**
 * One upgraded connection seen by the shared core as its byte sink. Every
 * NDJSON frame the core writes becomes exactly one BINARY message, bytes
 * identical to what the TCP listener writes. `send` takes a whole message
 * (sent, or buffered under backpressure) or drops it because the socket is
 * closing, so a frame is never split across messages.
 */
class WsDoor implements BunSocket {
  data: SocketData | undefined;
  socket: ServerWebSocket<WsDoor> | undefined;

  write(bytes: Buffer | Uint8Array | string): number {
    return this.socket?.send(bytes) === 0 ? 0 : bytes.length;
  }

  end(): void {
    this.socket?.close();
  }
}

/**
 * The WebSocket listener (#1830): the SAME framing, correlation, limits,
 * backpressure and connection registry as the Unix and TLS-TCP listeners,
 * behind an HTTP upgrade of `/machine` over the host TLS identity. One
 * binary message carries one NDJSON frame (newline included), so a frame
 * decoder sees the bytes the TCP carrier would deliver. The upgrade does not
 * expose the client certificate, so `peerFingerprintOf` is undefined here as
 * for Unix connections: admission rests on the enrollment selected by the
 * offered machine id until the signed handshake (#1832) binds the peer key.
 */
export function createIpcWsServer(
  spec: IpcWsListenSpec,
  handler: RequestHandler,
  options: IpcServerOptions,
): Effect.Effect<IpcWsServer, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher({ bound: options.dispatcherBound });
    const core = makeServerCore(handler, options, dispatch);
    const door = yield* bindDoor(core, () => Bun.serve<WsDoor>({
      hostname: spec.host,
      port: spec.port,
      tls: { cert: spec.tls.certificate, key: spec.tls.privateKey },
      fetch(request, server) {
        if (new URL(request.url).pathname !== IPC_WS_PATH) return new Response("not found", { status: 404 });
        if (server.upgrade(request, { data: new WsDoor() })) return undefined;
        return new Response("websocket upgrade required", { status: 426 });
      },
      websocket: {
        // The decoder's cap plus the frame's newline: a message Bun refuses
        // (close 1009) is exactly one the line decoder would refuse.
        maxPayloadLength: MAX_FRAME_BYTES + 1,
        open(ws) {
          ws.data.socket = ws;
          core.open(ws.data);
        },
        message(ws, message) {
          if (typeof message === "string") {
            ws.close(UNSUPPORTED_DATA, "the machine wire carries binary frames only");
            return;
          }
          core.handlers.data(ws.data, message);
        },
        drain(ws) {
          core.handlers.drain(ws.data);
        },
        close(ws) {
          core.handlers.close(ws.data);
        },
      },
    }), (server) => { void server.stop(true); });
    return { host: spec.host, port: door.server.port ?? spec.port, ...core.api, close: () => door.close };
  });
}
