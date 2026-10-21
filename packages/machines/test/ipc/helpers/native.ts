import { Effect } from "effect";
import type { IdSource, Ipc } from "@oni/protocol";
import { connectIpcClient as connect, connectIpcTcpClient as connectTcp, createIpcServer as listen, createIpcTcpServer as listenTcp, typedCall as nativeCall } from "../../../src";
import type { IpcTcpConnectSpec, IpcTcpListenSpec } from "../../../src";
import { PeerRequestTable as NativeTable } from "../../../src/ipc/peer-request-table";
import { decodeIpcFailure } from "../../../src/failure";
import { acquire, run, sync } from "./effects";
export * from "../../../src/ipc/errors";
export { classifyIpcMessage } from "../../../src/ipc/peer-request-table";

export function sequentialIds(prefix: string): IdSource {
  let n = 0;
  return () => { n += 1; return `${prefix}-${n}`; };
}
type Handler = (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void, notify: (method: string, params?: Ipc.Notification["params"]) => void, connectionId: string) => void | Promise<void>;
function handlerEffect(body: () => void | Promise<void>) {
  return Effect.try({ try: body, catch: decodeIpcFailure("test.handler") }).pipe(Effect.flatMap((result) => result instanceof Promise ? Effect.tryPromise({ try: () => result, catch: decodeIpcFailure("test.handler") }) : Effect.void));
}
type ClientTestOptions = {
  idSource?: IdSource; dispatcherBound?: number; connectTimeoutMs?: number; onDisconnect?: () => void;
  onRequest?: (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => void | Promise<void>;
  onNotification?: (method: string, params: Ipc.Notification["params"]) => void | Promise<void>;
};
function nativeClientOptions(options: ClientTestOptions) {
  return {
    idSource: options.idSource ?? sequentialIds("client-req"),
    dispatcherBound: options.dispatcherBound ?? 64,
    connectTimeoutMs: options.connectTimeoutMs,
    onDisconnect: options.onDisconnect ? () => handlerEffect(() => options.onDisconnect?.()) : undefined,
    onRequest: options.onRequest ? (method: string, params: Ipc.Request["params"], respond: (result: Ipc.Response["result"]) => void) => handlerEffect(() => options.onRequest?.(method, params, respond)) : undefined,
    onNotification: options.onNotification ? (method: string, params: Ipc.Notification["params"]) => handlerEffect(() => options.onNotification?.(method, params)) : undefined,
  };
}
function wrapClient(native: import("../../../src").IpcClient, close: () => Promise<void>) {
  return { native, get connected() { return native.connected; },
    call: (...args: Parameters<typeof native.call>) => run(native.call(...args)),
    close: async () => { await run(native.close()); await close(); },
  };
}
export async function connectIpcClient(path: string, options: ClientTestOptions = {}) {
  const { value: native, close } = await acquire(connect(path, nativeClientOptions(options)));
  return wrapClient(native, close);
}
export async function connectIpcTcpClient(spec: IpcTcpConnectSpec, options: ClientTestOptions = {}) {
  const { value: native, close } = await acquire(connectTcp(spec, nativeClientOptions(options)));
  return wrapClient(native, close);
}
export type IpcClient = Awaited<ReturnType<typeof connectIpcClient>>;
type ServerTestOptions = { idSource?: IdSource; dispatcherBound?: number; onDisconnect?: (id: string) => void };
function nativeServerOptions(options: ServerTestOptions) {
  return {
    idSource: options.idSource ?? sequentialIds("server-req"),
    dispatcherBound: options.dispatcherBound ?? 64,
    onDisconnect: options.onDisconnect ? (id: string) => handlerEffect(() => options.onDisconnect?.(id)) : undefined,
  };
}
type ServerNative = Pick<import("../../../src").IpcServer, "call" | "notify" | "useConnection" | "peerFingerprintOf" | "close">;
function wrapServer<N extends ServerNative>(native: N, close: () => Promise<void>) {
  return { native,
    call: (...args: Parameters<ServerNative["call"]>) => run(native.call(...args)),
    notify: (...args: Parameters<ServerNative["notify"]>) => sync(native.notify(...args)),
    useConnection: native.useConnection,
    peerFingerprintOf: (connectionId: string) => native.peerFingerprintOf(connectionId),
    close: async () => { await run(native.close()); await close(); },
  };
}
export async function createIpcServer(path: string, handler: Handler, options: ServerTestOptions = {}) {
  const { value: native, close } = await acquire(listen(path, (...args) => handlerEffect(() => handler(...args)), nativeServerOptions(options)));
  return { ...wrapServer(native, close), socketPath: native.socketPath };
}
export async function createIpcTcpServer(spec: IpcTcpListenSpec, handler: Handler, options: ServerTestOptions = {}) {
  const { value: native, close } = await acquire(listenTcp(spec, (...args) => handlerEffect(() => handler(...args)), nativeServerOptions(options)));
  return { ...wrapServer(native, close), host: native.host, port: native.port };
}
export type IpcServer = Awaited<ReturnType<typeof createIpcServer>>;
export function typedCall<M extends keyof typeof Ipc.Methods>(caller: Pick<IpcClient, "native"> | Pick<IpcServer, "native">, method: M, params: (typeof Ipc.Methods)[M]["params"]["_input"], timeoutMs?: number) {
  return run(nativeCall(caller.native, method, params, timeoutMs));
}
type TableOptions<P> = {
  readonly send: (
    peer: P,
    frame: Ipc.Request | Ipc.Response | Ipc.Notification,
  ) => void;
  readonly idSource?: IdSource;
  readonly onRequest?: (
    peer: P,
    method: string,
    params: Ipc.Request["params"],
    respond: (result: Ipc.Response["result"]) => void,
    notify: (method: string, params?: Ipc.Notification["params"]) => void,
  ) => void | Promise<void>;
  readonly onNotification?: (
    peer: P,
    method: string,
    params: Ipc.Notification["params"],
  ) => void | Promise<void>;
  readonly missingRequestHandlerMessage?: (method: string) => string;
  readonly samePeer?: (pendingPeer: P, inboundPeer: P) => boolean;
};
export class PeerRequestTable<P = undefined> {
  private readonly native: NativeTable<P>;
  constructor(options: TableOptions<P>) {
    this.native = new NativeTable({ ...options,
      idSource: options.idSource ?? sequentialIds("table-req"),
      onRequest: options.onRequest ? (...args) => handlerEffect(() => options.onRequest?.(...args)) : undefined,
      onNotification: options.onNotification ? (...args) => handlerEffect(() => options.onNotification?.(...args)) : undefined,
    });
  }
  call(...args: Parameters<NativeTable<P>["call"]>) { return run(this.native.call(...args)); }
  dispatch(...args: Parameters<NativeTable<P>["dispatch"]>) { return sync(this.native.dispatch(...args)); }
  dispatchMessage(...args: Parameters<NativeTable<P>["dispatchMessage"]>) { return sync(this.native.dispatchMessage(...args)); }
  disconnect(...args: Parameters<NativeTable<P>["disconnect"]>) { this.native.disconnect(...args); }
  disconnectAll(...args: Parameters<NativeTable<P>["disconnectAll"]>) { this.native.disconnectAll(...args); }
}
