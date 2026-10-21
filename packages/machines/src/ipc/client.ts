import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { IdSource, Ipc, PlainValue } from "@oni/protocol";
import { Effect, type Scope } from "effect";
import { IpcConnectionError, IpcPeerKeyMismatchError, IpcProtocolError, type IpcError } from "./errors";
import { decodeIpcFailure } from "../failure";
import { makeDispatcher, type Dispatch } from "./callbacks";
import { LineDecoder, encode } from "./framing";
import { classifyIpcMessage, PeerRequestTable } from "./peer-request-table";
import { certificateKeyFingerprint, type IpcTlsIdentity } from "./tls";

export interface IpcClient {
  call(method: string, params?: Ipc.Request["params"], timeoutMs?: number): Effect.Effect<Ipc.Response["result"], IpcError>;
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
  readonly socket: net.Socket;
  /**
   * Maps a socket error to a typed failure that overrides the generic
   * `IpcConnectionError` — the TLS transport routes host-identity failures
   * (handshake chain or pin, both strictly before `readyEvent` and therefore
   * before any frame can be written) to `IpcPeerKeyMismatchError` here. An
   * undefined result keeps the default connection-failure classification.
   */
  readonly classifyError?: (error: Error) => IpcError | undefined;
};

/** One connected-byte-stream contract; Unix and TLS-over-TCP differ only here. */
type ClientTransport = {
  /** Names the target in connect-timeout errors. */
  readonly endpoint: string;
  /** The event that marks the stream ready for frames (TLS: after handshake). */
  readonly readyEvent: "connect" | "secureConnect";
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

/** TLS-over-TCP connection spec (#1270): chain-verified host, pinned key. */
export type IpcTcpConnectSpec = {
  readonly tcp: { readonly host: string; readonly port: number };
  /** The client identity presented to the server's mutual-TLS requirement. */
  readonly tls: IpcTlsIdentity;
  /**
   * PEM of the HOST's certificate: the sole trust anchor the presented chain
   * must validate against (`ca` + `rejectUnauthorized: true`), and the key
   * whose fingerprint the presented certificate must carry. Either failure
   * surfaces as one typed `IpcPeerKeyMismatchError` before any frame is sent.
   */
  readonly hostCertificate: string;
};

/**
 * The OpenSSL X509 verify codes a failed chain validation of the host
 * certificate surfaces with: ONE host-identity failure class together with
 * the pin mismatch, so callers (daemon reconnect: terminal; CLI: typed
 * refusal) never see chain and pin failures diverge.
 */
const X509_VERIFY_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_SIGNATURE_FAILURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
]);

export function connectIpcTcpClient(spec: IpcTcpConnectSpec, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  const expected = certificateKeyFingerprint(new X509Certificate(spec.hostCertificate).raw);
  return connectOverTransport({
    endpoint: `${spec.tcp.host}:${spec.tcp.port}`,
    readyEvent: "secureConnect",
    start: () => {
      const socket = tls.connect({
        host: spec.tcp.host,
        port: spec.tcp.port,
        cert: spec.tls.certificate,
        key: spec.tls.privateKey,
        // The configured host certificate IS the trust store: the presented
        // chain must validate against it, then checkServerIdentity pins the
        // key. CN-only self-signed host certs keep working — the identity
        // check is the SPKI fingerprint, never hostname semantics.
        ca: [spec.hostCertificate],
        rejectUnauthorized: true,
        checkServerIdentity: (_host: string, peer: tls.PeerCertificate) => hostPinMismatch(peer.raw, expected),
      });
      return { socket, classifyError: (error) => hostVerificationFailure(error, expected) };
    },
  }, opts);
}

/** The in-handshake pin check: undefined admits, the typed error aborts. */
function hostPinMismatch(presentedDer: Uint8Array, expected: string): IpcPeerKeyMismatchError | undefined {
  const presented = certificateKeyFingerprint(presentedDer);
  if (presented === expected) return undefined;
  return new IpcPeerKeyMismatchError({
    message: `host key mismatch: expected ${expected}, presented ${presented}`,
    expected,
    presented,
  });
}

/**
 * One host-identity failure class: the pin error object that
 * checkServerIdentity returned surfaces verbatim on the socket, and an
 * OpenSSL chain-verification failure (which fires BEFORE checkServerIdentity
 * ever runs, with no peer certificate readable — probed on Bun 1.4.1/1.4.2)
 * becomes the same typed error with `presented: "unverified"` and the
 * verification `code`.
 */
function hostVerificationFailure(error: Error, expected: string): IpcError | undefined {
  if (error instanceof IpcPeerKeyMismatchError) return error;
  const code = (error as Error & { readonly code?: string }).code;
  if (code === undefined || !X509_VERIFY_CODES.has(code)) return undefined;
  return new IpcPeerKeyMismatchError({
    message: `host certificate verification failed (${code}): ${error.message}`,
    expected,
    presented: "unverified",
    code,
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

function connectOverTransport(transport: ClientTransport, opts: ConnectIpcClientOptions): Effect.Effect<IpcClient, IpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const dispatch = yield* makeDispatcher({ bound: opts.dispatcherBound });
    const decoder = new LineDecoder();
    let socket: net.Socket | undefined;
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
        // A host-identity failure (chain or pin) kills the handshake BEFORE
        // `readyEvent` and therefore before `connected` ever turns true, so
        // no frame was or can be sent. No fallback transport exists.
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
