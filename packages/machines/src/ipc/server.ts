import fs from "node:fs";
import net from "node:net";
import { type IdSource, Ipc, type PlainValue } from "@oni/protocol";

import { Effect, type Scope } from "effect";
import { IpcConnectionError, type IpcError } from "./errors";
import { decodeIpcFailure } from "../failure";
import { makeDispatcher, type Dispatch } from "./callbacks";
import { LineDecoder, encode } from "./framing";
import { classifyIpcMessage, PeerRequestTable } from "./peer-request-table";
import { certificateKeyFingerprint, type IpcTlsIdentity } from "./tls";

/** Remove the socket file, tolerating a concurrent removal (ENOENT). */
function unlinkIfExists(socketPath: string): void {
  fs.rmSync(socketPath, { force: true });
}

interface IpcServerOptions {
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly idSource: IdSource;
  /** Callback dispatcher bound (#1312): required, the composition chooses it. */
  readonly dispatcherBound: number;
  /**
   * Fires once per connection after it is torn down (close or error). The
   * connection's in-flight requests have already been failed when this runs.
   */
  readonly onDisconnect?: (connectionId: string) => Effect.Effect<void, IpcError>;
}

type RequestHandler = (
  method: string,
  params: Ipc.Request["params"],
  respond: (result: Ipc.Response["result"]) => void,
  notify: (method: string, params?: Ipc.Notification["params"]) => void,
  connectionId: string,
) => Effect.Effect<void, IpcError>;

/** Transport-independent request/notification surface shared by both listeners. */
interface IpcServerApi {
  call(
    method: string,
    params?: Ipc.Request["params"],
    timeoutMs?: number,
  ): Effect.Effect<Ipc.Response["result"], IpcError>;
  /** Returns false when the notification was dropped because no client is connected. */
  notify(method: string, params?: Ipc.Notification["params"]): Effect.Effect<boolean, IpcError>;
  useConnection(id: string): void;
  /** Fail pending calls before closing one revoked peer, leaving other peers live. */
  disconnect(id: string): void;
  /**
   * The mutual-TLS peer key fingerprint of a live connection (#1270), or
   * undefined for Unix connections. The HANDLER judges it (the host compares
   * it against the enrollment selected by the offered machineId); the
   * transport only extracts and exposes it.
   */
  peerFingerprintOf(connectionId: string): string | undefined;
  close(): Effect.Effect<void, IpcError>;
}

export interface IpcServer extends IpcServerApi {
  readonly socketPath: string;
}

export interface IpcTcpServer extends IpcServerApi {
  readonly host: string;
  /** The bound port — the real one when the spec asked for port 0. */
  readonly port: number;
}

/** TLS-over-TCP listener spec: mutual TLS, trust pinned by the attach handler. */
export type IpcTcpListenSpec = {
  readonly host: string;
  readonly port: number;
  readonly tls: IpcTlsIdentity;
};

// How long the pre-listen probe waits for the existing socket to answer
// before concluding it is dead. No answer means "assume live": stealing a
// live server's socket wedges BOTH servers, so ambiguity resolves to refusal.
const SOCKET_PROBE_TIMEOUT_MS = 500;

/**
 * True when something accepts connections on `socketPath`. Connection refused
 * (or any other connect error) means the socket file is a stale leftover.
 */
function probeSocketLive(socketPath: string): Effect.Effect<boolean> {
  return Effect.callback<boolean>((resume) => {
    const probe = new net.Socket();
    probe.once("error", () => { probe.destroy(); resume(Effect.succeed(false)); });
    probe.once("connect", () => { probe.destroy(); resume(Effect.succeed(true)); });
    probe.connect(socketPath);
    return Effect.sync(() => probe.destroy());
  }).pipe(Effect.timeoutOption(SOCKET_PROBE_TIMEOUT_MS), Effect.map((value) => value._tag === "None" || value.value));
}

interface SocketData {
  id: string;
}

interface BunSocket {
  data: SocketData | undefined;
  write(data: Buffer | Uint8Array | string): number;
  end(): void;
}

/** What the TLS listener's handshake callback reads off the Bun socket. */
interface TlsBunSocket extends BunSocket {
  getPeerCertificate(): { readonly raw?: Buffer } | null;
}

type ConnectionState = {
  id: string;
  socket: BunSocket;
  decoder: LineDecoder;
  /** sha256(SPKI DER) of the mutual-TLS client certificate; Unix has none. */
  peerFingerprint: string | undefined;
  /**
   * Bytes the kernel did not accept yet. Bun sockets do NOT buffer partial
   * writes (unlike node:net) — whatever `socket.write` returns short must
   * be kept here and flushed on `drain`, or the frame is silently
   * truncated and the NDJSON stream desyncs.
   */
  writeQueue: Uint8Array[];
  /** Close the socket once every queued byte flushed (protocol desync). */
  endAfterFlush: boolean;
  /** The socket is gone; drop writes instead of queueing them forever. */
  closed: boolean;
};

/**
 * The transport-independent half of an IPC server: framing, correlation,
 * limits, backpressure and the connection registry over any connected byte
 * stream Bun hands us. `open` is the stream-ready entry point — the Unix
 * listener calls it on socket open, the TLS listener only after the handshake
 * produced a client certificate fingerprint.
 */
interface ServerCore {
  open(socket: BunSocket, peerFingerprint?: string): void;
  readonly handlers: {
    data(socket: BunSocket, raw: Buffer): void;
    drain(socket: BunSocket): void;
    close(socket: BunSocket): void;
  };
  disconnectAll(message: string): void;
  readonly api: Omit<IpcServerApi, "close">;
}

function makeServerCore(handler: RequestHandler, options: IpcServerOptions, dispatch: Dispatch): ServerCore {
  function connectionIdOf(socket: BunSocket): string | undefined {
    return socket.data?.id;
  }

  const connections = new Map<string, ConnectionState>();
  let connCounter = 0;
  let activeConnectionId: string | undefined;

  function send(state: ConnectionState, bytes: Uint8Array): void {
    if (state.closed) return;
    if (state.writeQueue.length > 0) {
      // Earlier bytes are still waiting for drain — writing now would
      // interleave into the middle of a queued frame.
      state.writeQueue.push(bytes);
      return;
    }
    const written = state.socket.write(bytes);
    if (written < bytes.length) {
      state.writeQueue.push(written > 0 ? bytes.subarray(written) : bytes);
    }
  }

  function sendFrame(state: ConnectionState, msg: Ipc.Request | Ipc.Response | Ipc.Notification): void {
    send(state, encode(msg));
  }

  const peer = new PeerRequestTable<ConnectionState>({
    idSource: options.idSource,
    send: sendFrame,
    samePeer: (pendingPeer, inboundPeer) => pendingPeer.id === inboundPeer.id,
    onRequest: (state, method, params, respond, notify) =>
      handler(method, params, respond, notify, state.id),
    onNotification: (state, method, params) =>
      handler(
        method,
        params,
        () => undefined,
        () => undefined,
        state.id,
      ),
  });

  function flushQueued(state: ConnectionState): void {
    if (state.closed) return;
    while (state.writeQueue.length > 0) {
      const chunk = state.writeQueue[0] as Uint8Array;
      const written = state.socket.write(chunk);
      if (written < chunk.length) {
        if (written > 0) state.writeQueue[0] = chunk.subarray(written);
        return; // kernel buffer full again — wait for the next drain
      }
      state.writeQueue.shift();
    }
    if (state.endAfterFlush) state.socket.end();
  }

  /**
   * Close once every queued byte flushed. end() half-closes: the already
   * flushed error frame reaches the peer with the FIN behind it, and Bun
   * fires this side's close handler (which releases the connection state and
   * fails its pendings). The IpcClient tears down on that FIN; a foreign
   * peer stuck mid-flood only strands its own socket, not the server's.
   */
  function closeAfterFlush(state: ConnectionState): void {
    state.endAfterFlush = true;
    if (state.writeQueue.length === 0 && !state.closed) state.socket.end();
  }

  function getActiveConnection(): ConnectionState | undefined {
    if (activeConnectionId) {
      return connections.get(activeConnectionId);
    }
    const first = connections.values().next();
    return first.done ? undefined : first.value;
  }

  function removeConnection(id: string, reason: string): void {
    const state = connections.get(id);
    if (state) state.closed = true;
    connections.delete(id);
    if (id === activeConnectionId) {
      // Clear the pin: leaving it set to a now-dead connection wedges
      // getActiveConnection() (it resolves the stale id, finds nothing, and
      // never falls through to a surviving connection), so no next
      // connection binds.
      activeConnectionId = undefined;
    }
    // A dead connection fails ITS in-flight requests as a connection loss —
    // leaving them to age out would misreport the failure as a timeout. This
    // includes requests whose bytes were still sitting in the write queue.
    if (state) peer.disconnect(state, new IpcConnectionError({ message: reason }));
    // `state` guards double delivery: close always follows error, and the
    // second call finds the connection already deleted.
    if (state && options.onDisconnect) {
      const full = dispatch(options.onDisconnect(id));
      // The disconnect callback must not vanish: a full dispatcher at
      // teardown is a composition fault — fail loudly (#1312).
      if (full !== undefined) throw full;
    }
  }

  function dispatchFrame(msg: PlainValue, state: ConnectionState): Effect.Effect<void, IpcError> {
    const message = classifyIpcMessage(msg);
    if (message === undefined) return Effect.sync(() => sendFrame(state, Ipc.createErrorResponse(extractFrameId(msg), 4000, unknownMessageError(msg))));
    if (message.kind === "response") return peer.dispatchMessage(message, state);
    return Effect.suspend(() => {
      const full = dispatch(peer.dispatchMessage(message, state).pipe(Effect.catchCause((cause) => Effect.logError("IPC request handler defect", cause).pipe(Effect.andThen(Effect.sync(() => {
        removeConnection(state.id, "request handler defect");
        state.socket.end();
      }))))));
      return full === undefined ? Effect.void : Effect.fail(full);
    });
  }

  function stateOf(socket: BunSocket): ConnectionState | undefined {
    const connId = connectionIdOf(socket);
    return connId === undefined ? undefined : connections.get(connId);
  }

  return {
    open(socket, peerFingerprint) {
      const id = `conn-${++connCounter}`;
      socket.data = { id } satisfies SocketData;
      connections.set(id, {
        id,
        socket,
        decoder: new LineDecoder(),
        peerFingerprint,
        writeQueue: [],
        endAfterFlush: false,
        closed: false,
      });
    },
    handlers: {
      data(socket, raw) {
        const state = stateOf(socket);
        if (!state) return;
        // A condemned connection's remaining inbound flood is dropped without
        // decoding: re-buffering megabytes of garbage per chunk pins the event
        // loop (and the reclaim timer with it) for nothing.
        if (state.endAfterFlush) return;

        const full = dispatch(Effect.gen(function* () {
          if (state.endAfterFlush || state.closed) return;
          const { frames: messages, malformed } = yield* Effect.try({ try: () => state.decoder.push(raw), catch: decodeIpcFailure("frame.decode") });
          for (const msg of messages) yield* dispatchFrame(msg, state);
          for (const line of malformed) sendFrame(state, Ipc.createErrorResponse("unknown", 4001, `IPC frame is not valid JSON: ${line}`));
        }).pipe(Effect.catch((error) => Effect.sync(() => {
          sendFrame(state, Ipc.createErrorResponse("unknown", 4001, error.message || String(error)));
          closeAfterFlush(state);
        }))));
        // Typed backpressure (#1312): the offerer gets an error frame and the
        // overloaded connection is condemned — never a silent drop.
        if (full !== undefined) { sendFrame(state, Ipc.createErrorResponse("unknown", 4001, full.message)); closeAfterFlush(state); }
      },
      drain(socket) {
        const state = stateOf(socket);
        if (state) flushQueued(state);
      },
      close(socket) {
        // Bun delivers close after socket errors, so this is the single
        // teardown path. The connection may die before `open` assigned data.
        const id = connectionIdOf(socket);
        if (id !== undefined) removeConnection(id, "socket closed");
      },
    },
    disconnectAll(message) {
      peer.disconnectAll(new IpcConnectionError({ message }));
    },
    api: {
      call(method, params, timeoutMs = 30_000) {
        return Effect.suspend(() => {
          const conn = getActiveConnection();
          return conn ? peer.call(conn, method, params, timeoutMs) : new IpcConnectionError({ message: "no connected client" });
        });
      },
      notify(method, params) {
        return Effect.try({ try: () => {
          const conn = getActiveConnection();
          if (!conn) return false;
          sendFrame(conn, Ipc.createNotification(method, params));
          return true;
        }, catch: decodeIpcFailure("server.notify") });
      },
      useConnection(id) {
        if (connections.has(id)) activeConnectionId = id;
      },
      disconnect(id) {
        const state = connections.get(id);
        removeConnection(id, "connection revoked");
        state?.socket.end();
      },
      peerFingerprintOf(connectionId) {
        return connections.get(connectionId)?.peerFingerprint;
      },
    },
  };
}

/** Idempotent server shutdown shared by both listeners. */
function makeServerClose(core: ServerCore, stop: () => void): Effect.Effect<void, IpcError> {
  let closed = false;
  return Effect.try({ try: () => {
    if (closed) return;
    closed = true;
    core.disconnectAll("server closed");
    stop();
  }, catch: decodeIpcFailure("server.close") });
}

/** One Bun.listen door over the shared core: typed listen failure plus scoped idempotent close. */
function bindDoor<T>(
  core: ServerCore,
  listen: () => T,
  stop: (server: T) => void,
): Effect.Effect<{ readonly server: T; readonly close: Effect.Effect<void, IpcError> }, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const server = yield* Effect.try({ try: listen, catch: decodeIpcFailure("server.listen") });
    const close = makeServerClose(core, () => stop(server));
    yield* Effect.addFinalizer(() => Effect.orDie(close));
    return { server, close };
  });
}

export function createIpcServer(
  socketPath: string,
  handler: RequestHandler,
  options: IpcServerOptions,
): Effect.Effect<IpcServer, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher({ bound: options.dispatcherBound });
    // A leftover socket file blocks Bun.listen with EADDRINUSE — but blindly
    // unlinking would steal a LIVE server's socket (new connections silently
    // divert to the newcomer while the old server keeps running blind). Probe
    // first; only a provably dead socket file is removed.
    if (fs.existsSync(socketPath)) {
      if (yield* probeSocketLive(socketPath)) {
        return yield* new IpcConnectionError({ message: `socket ${socketPath} is in use by a live server` });
      }
      yield* Effect.try({ try: () => unlinkIfExists(socketPath), catch: decodeIpcFailure("socket.unlink") });
    }

    const core = makeServerCore(handler, options, dispatch);
    const door = yield* bindDoor(core, () => Bun.listen({
      unix: socketPath,
      socket: {
        open(socket: BunSocket) {
          core.open(socket);
        },
        ...core.handlers,
      },
    }), (server) => {
      server.stop(true);
      unlinkIfExists(socketPath);
    });
    return { socketPath, ...core.api, close: () => door.close };
  });
}

/**
 * The TLS-over-TCP listener (#1270): the SAME framing, correlation, limits,
 * backpressure and connection registry as the Unix listener, behind a mutual
 * TLS handshake. Chain verification is off by design — the trust model is the
 * pinned key fingerprint, which the handler reads via `peerFingerprintOf`.
 */
export function createIpcTcpServer(
  spec: IpcTcpListenSpec,
  handler: RequestHandler,
  options: IpcServerOptions,
): Effect.Effect<IpcTcpServer, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher({ bound: options.dispatcherBound });
    const core = makeServerCore(handler, options, dispatch);
    const door = yield* bindDoor(core, () => Bun.listen({
      hostname: spec.host,
      port: spec.port,
      tls: {
        cert: spec.tls.certificate,
        key: spec.tls.privateKey,
        requestCert: true,
        rejectUnauthorized: false,
      },
      socket: {
        // No `open` registration: Bun fires open BEFORE the TLS handshake, so
        // no peer certificate exists yet. The connection becomes real only in
        // `handshake`, and TLS delivers no application data before that.
        handshake(socket: TlsBunSocket) {
          const raw = socket.getPeerCertificate()?.raw;
          if (raw === undefined) {
            // Mutual TLS: a client that presented no certificate never
            // becomes a connection — there is nothing to pin it by.
            socket.end();
            return;
          }
          core.open(socket, certificateKeyFingerprint(raw));
        },
        ...core.handlers,
      },
    }), (server) => server.stop(true));
    return { host: spec.host, port: door.server.port, ...core.api, close: () => door.close };
  });
}

// Cap how much of an unrecognized payload the error message echoes back.
const MAX_ERROR_PAYLOAD_CHARS = 200;

function unknownMessageError(raw: PlainValue): string {
  return `Unknown message type: ${String(JSON.stringify(raw)).slice(0, MAX_ERROR_PAYLOAD_CHARS)}`;
}

/** The offending frame's own id when it carries a string one, else "unknown". */
function extractFrameId(raw: PlainValue): string {
  if (raw !== null && typeof raw === "object" && "id" in raw) {
    const id = raw.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "unknown";
}
