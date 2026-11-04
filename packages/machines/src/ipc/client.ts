import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { Ipc, type IdSource, type PlainValue } from "@oni/protocol";
import { Effect, type Scope } from "effect";
import { IpcConnectionError, IpcPeerKeyMismatchError, IpcProtocolError, type IpcError } from "./errors";
import { decodeIpcFailure } from "../failure";
import { makeDispatcher, type Dispatch } from "./callbacks";
import { LineDecoder, encode } from "./framing";
import { classifyIpcMessage, PeerRequestTable } from "./peer-request-table";
import { hostPinOf, type IpcTlsIdentity } from "./tls";

export interface IpcClient {
  call(method: string, params?: Ipc.Request["params"], timeoutMs?: number): Effect.Effect<Ipc.Response["result"], IpcError>;
  notify(method: string, params?: Ipc.Notification["params"]): Effect.Effect<void, IpcError>;
  close(): Effect.Effect<void, IpcError>;
  readonly connected: boolean;
}
export type ConnectIpcClientOptions = {
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly idSource: IdSource;
  /** Callback dispatcher bound (#1312): required, the composition chooses it. */
  readonly dispatcherBound: number;
  connectTimeoutMs?: number;
  onDisconnect?: () => Effect.Effect<void, IpcError>;
  onRequest?: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => Effect.Effect<void, IpcError>;
  onNotification?: (method: string, params: Ipc.Notification["params"]) => Effect.Effect<void, IpcError>;
};

/** A started connection attempt: the socket plus its error classification. */
type StartedSocket = {
  /** A node socket for Unix and TLS-TCP; the frame stream over an upgraded WebSocket. */
  readonly socket: Duplex;
  /**
   * Maps a socket error to a typed failure that overrides the generic
   * `IpcConnectionError` — the TLS transport routes a host pin mismatch
   * (judged strictly before `readyEvent` and therefore before any frame can
   * be written) to `IpcPeerKeyMismatchError` here. An undefined result keeps
   * the default connection-failure classification.
   */
  readonly classifyError?: (error: Error) => IpcError | undefined;
};

/**
 * The event a pinned dial emits once the host's presented key matched the
 * pin: the ready signal of both TLS carriers. The socket's own
 * `secureConnect` fires before the key is judged and is never the signal.
 */
export const HOST_PINNED = "hostPinned";

/** One connected-byte-stream contract; the Unix, TLS-over-TCP and WebSocket carriers differ only here. */
export type ClientTransport = {
  /** Names the target in connect-timeout errors. */
  readonly endpoint: string;
  /** The event that marks the stream ready for frames (TLS: after the pin matched; WebSocket: after the upgrade). */
  readonly readyEvent: "connect" | typeof HOST_PINNED | "open";
  /** Creates the socket and initiates the connection. */
  readonly start: () => StartedSocket;
};

export function connectIpcClient(socketPath: string, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return connectOverTransport({
    endpoint: socketPath,
    readyEvent: "connect",
    start: () => {
      const socket = new net.Socket();
      socket.connect(socketPath);
      return { socket };
    },
  }, opts);
}

/** TLS-over-TCP connection spec (#1270): mutual TLS, the host judged by its key pin alone. */
export type IpcTcpConnectSpec = {
  readonly tcp: { readonly host: string; readonly port: number };
  /** The client identity presented to the server's mutual-TLS requirement. */
  readonly tls: IpcTlsIdentity;
  /**
   * The host key's pin (`hostPinOf`): the only trust the dial holds. No
   * chain is verified, so a certificate reissued for the pinned key is
   * accepted and any other key is one typed `IpcPeerKeyMismatchError`
   * before any frame is sent.
   */
  readonly hostPin: string;
};

/** The pinned mutual-TLS target shared by the TCP and WebSocket carriers. */
export type PinnedTlsTarget = {
  readonly host: string;
  readonly port: number;
  readonly tls: IpcTlsIdentity;
  readonly hostPin: string;
};

/** A pinned TLS session: the socket plus the host-identity failure classifier. */
export type PinnedTlsSocket = {
  readonly socket: tls.TLSSocket;
  readonly classifyError: (error: Error) => IpcError | undefined;
};

/**
 * The dial behind both TLS carriers. The handshake verifies no chain and no
 * hostname: the presented leaf's key is judged against the pin the moment
 * the handshake completes, before anything is written. A match emits
 * `HOST_PINNED`; a mismatch destroys the socket with the typed refusal, which
 * `classifyError` then surfaces verbatim.
 */
export function pinnedTlsDial(target: PinnedTlsTarget): () => PinnedTlsSocket {
  return () => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      cert: target.tls.certificate,
      key: target.tls.privateKey,
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      const refusal = hostPinMismatch(socket.getPeerCertificate(true).raw, target.hostPin);
      if (refusal === undefined) socket.emit(HOST_PINNED);
      else socket.destroy(refusal);
    });
    return { socket, classifyError: (error) => (error instanceof IpcPeerKeyMismatchError ? error : undefined) };
  };
}

export function connectIpcTcpClient(spec: IpcTcpConnectSpec, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  const dial = pinnedTlsDial({ ...spec.tcp, tls: spec.tls, hostPin: spec.hostPin });
  return connectOverTransport({ endpoint: `${spec.tcp.host}:${spec.tcp.port}`, readyEvent: HOST_PINNED, start: dial }, opts);
}

function hostPinMismatch(presentedDer: Uint8Array, expected: string): IpcPeerKeyMismatchError | undefined {
  const presented = hostPinOf(presentedDer);
  if (presented === expected) return undefined;
  return new IpcPeerKeyMismatchError({
    message: `host key mismatch: expected ${expected}, presented ${presented}`,
    expected,
    presented,
  });
}

type ClientFrameSink = {
  readonly decoder: LineDecoder;
  readonly peer: PeerRequestTable<undefined>;
  readonly dispatch: Dispatch;
  /** Frame-level failure: fail pendings and tear the stream down. */
  readonly fail: (error: IpcError) => void;
};

function dispatchClientFrame(raw: PlainValue, sink: ClientFrameSink): Effect.Effect<void, IpcError> {
  const message = classifyIpcMessage(raw);
  if (message === undefined) {
    return Effect.logWarning(`IPC frame matched no message schema: ${String(JSON.stringify(raw)).slice(0, 200)}`);
  }
  if (message.kind === "response") return sink.peer.dispatchMessage(message, undefined);
  return Effect.suspend(() => {
    const full = sink.dispatch(sink.peer.dispatchMessage(message, undefined));
    return full === undefined ? Effect.void : Effect.fail(full);
  });
}

function makeClientDataHandler(sink: ClientFrameSink): (chunk: Buffer) => void {
  return (chunk) => {
    const full = sink.dispatch(Effect.gen(function* () {
      const { frames, malformed } = yield* Effect.try({ try: () => sink.decoder.push(chunk), catch: decodeIpcFailure("frame.decode") });
      for (const raw of frames) yield* dispatchClientFrame(raw, sink);
      if (malformed.length > 0) return yield* new IpcProtocolError({ message: `received invalid IPC frame: ${malformed[0]}` });
    }).pipe(Effect.catch((error) => Effect.sync(() => sink.fail(error)))));
    // A full dispatcher is typed backpressure: fail the stream, never drop bytes.
    if (full !== undefined) sink.fail(full);
  };
}

export function connectOverTransport(transport: ClientTransport, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher({ bound: opts.dispatcherBound });
    const decoder = new LineDecoder();
    let socket: Duplex | undefined;
    let connected = false;
    let closed = false;
    const peer = new PeerRequestTable({
      idSource: opts.idSource,
      send: (_peer, frame) => { if (connected && !closed) socket?.write(encode(frame)); },
      onRequest: opts.onRequest ? (_peer, method, params, respond) => opts.onRequest?.(method, params, respond) ?? Effect.void : undefined,
      onNotification: (_peer, method, params) => opts.onNotification?.(method, params) ?? Effect.void,
      missingRequestHandlerMessage: (method) => `client has no request handler for ${method}`,
    });
    const close = Effect.sync(() => {
      if (closed) return;
      closed = true;
      connected = false;
      peer.disconnectAll(new IpcConnectionError({ message: "client closed" }));
      socket?.destroy();
    });
    yield* Effect.addFinalizer(() => close);
    const client: IpcClient = {
      get connected() { return connected; },
      call(method, params, timeoutMs = 30_000) {
        return Effect.suspend(() => connected ? peer.call(undefined, method, params, timeoutMs) : new IpcConnectionError({ message: "not connected" }));
      },
      notify(method, params) {
        return Effect.suspend(() => connected
          ? Effect.sync(() => { socket?.write(encode(Ipc.createNotification(method, params))); })
          : new IpcConnectionError({ message: "not connected" }));
      },
      close: () => close,
    };
    const onData = makeClientDataHandler({
      decoder,
      peer,
      dispatch,
      fail: (error) => {
        connected = false;
        peer.disconnectAll(error);
        socket?.destroy();
      },
    });
    yield* Effect.callback<void, IpcError>((resume) => {
      // Create + wire in one synchronous block: no event can slip between the
      // connection attempt and its handlers.
      const started = transport.start();
      const stream = started.socket;
      socket = stream;
      stream.on("data", onData);
      stream.on("close", () => {
        connected = false;
        peer.disconnectAll(new IpcConnectionError({ message: "socket closed" }));
        if (opts.onDisconnect) {
          const full = dispatch(opts.onDisconnect());
          // The disconnect callback must not vanish: a full dispatcher at
          // teardown is a composition fault — fail loudly (#1312).
          if (full !== undefined) throw full;
        }
      });
      stream.on("end", () => {
        connected = false;
        peer.disconnectAll(new IpcConnectionError({ message: "socket closed by peer" }));
        stream.destroy();
      });
      stream.on("error", (error) => {
        // A host pin mismatch destroys the socket BEFORE `readyEvent` and
        // therefore before `connected` ever turns true, so no frame was or
        // can be sent. No fallback transport exists.
        const failure = started.classifyError?.(error) ?? new IpcConnectionError({ message: `socket error: ${error.message}`, cause: String(error) });
        connected = false;
        peer.disconnectAll(failure);
        resume(Effect.fail(failure));
      });
      stream.once(transport.readyEvent, () => {
        connected = true;
        resume(Effect.void);
      });
    }).pipe(
      Effect.timeoutOrElse({ duration: opts.connectTimeoutMs ?? 5000, orElse: () => Effect.fail(new IpcConnectionError({ message: `connect timeout: ${transport.endpoint}` }))}),
      Effect.onError(() => close),
    );
    return client;
  });
}
