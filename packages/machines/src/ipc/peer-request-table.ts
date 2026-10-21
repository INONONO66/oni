import { Ipc, type IdSource, type PlainValue } from "@oni/protocol";
import { Cause, Deferred, Effect, Exit, Option } from "effect";
import { IpcRemoteError, IpcTimeoutError, type IpcError } from "./errors";
import { decodeIpcFailure } from "../failure";

/** One inbound frame after schema classification; the only place the three wire schemas are tried. */
type IpcMessage =
  | { readonly kind: "response"; readonly value: Ipc.Response }
  | { readonly kind: "request"; readonly value: Ipc.Request }
  | { readonly kind: "notification"; readonly value: Ipc.Notification };

/** `undefined` when `raw` matches no IPC message schema. */
type IpcWireInput = PlainValue | Ipc.Request | Ipc.Response | Ipc.Notification;

export function classifyIpcMessage(raw: IpcWireInput): IpcMessage | undefined {
  const response = Ipc.Response.safeParse(raw);
  if (response.success) return { kind: "response", value: response.data };
  const request = Ipc.Request.safeParse(raw);
  if (request.success) return { kind: "request", value: request.data };
  const notification = Ipc.Notification.safeParse(raw);
  if (notification.success) return { kind: "notification", value: notification.data };
  return undefined;
}

type PendingCall<TPeer> = {
  readonly peer: TPeer;
  readonly method: string;
  readonly result: Deferred.Deferred<Ipc.Response["result"], IpcError>;
};
type SendFrame<TPeer> = (peer: TPeer, frame: Ipc.Request | Ipc.Response | Ipc.Notification) => void;
type RequestHandler<TPeer> = (
  peer: TPeer, method: string, params: Ipc.Request["params"],
  respond: (result: Ipc.Response["result"]) => void,
  notify: (method: string, params?: Ipc.Notification["params"]) => void,
) => Effect.Effect<void, IpcError>;
type NotificationHandler<TPeer> = (peer: TPeer, method: string, params: Ipc.Notification["params"]) => Effect.Effect<void, IpcError>;
type PeerRequestTableOptions<TPeer> = {
  readonly send: SendFrame<TPeer>;
  /** Injected request-id entropy (#1245): required, no ambient crypto fallback. */
  readonly idSource: IdSource;
  readonly onRequest?: RequestHandler<TPeer>;
  readonly onNotification?: NotificationHandler<TPeer>;
  readonly missingRequestHandlerMessage?: (method: string) => string;
  readonly samePeer?: (pendingPeer: TPeer, inboundPeer: TPeer) => boolean;
};

/** Request correlation is peer-scoped; interruption removes the waiter without replaying bytes. */
export class PeerRequestTable<TPeer = undefined> {
  private readonly pending = new Map<string, PendingCall<TPeer>>();
  private readonly samePeer: (pendingPeer: TPeer, inboundPeer: TPeer) => boolean;
  constructor(private readonly options: PeerRequestTableOptions<TPeer>) {
    this.samePeer = options.samePeer ?? Object.is;
  }
  call(peer: TPeer, method: string, params: Ipc.Request["params"], timeoutMs: number): Effect.Effect<Ipc.Response["result"], IpcError> {
    return Effect.gen({ self: this }, function* () {
      const request = Ipc.createRequest(this.options.idSource(), method, params);
      const result = yield* Deferred.make<Ipc.Response["result"], IpcError>();
      this.pending.set(request.id, { peer, method, result });
      return yield* Effect.try({ try: () => this.options.send(peer, request), catch: decodeIpcFailure("request.send") }).pipe(
        Effect.andThen(Deferred.await(result)),
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new IpcTimeoutError({ message: `request timeout: ${method}`, requestId: request.id, method }))}),
        Effect.ensuring(Effect.sync(() => { this.pending.delete(request.id); })),
      );
    });
  }
  dispatch(raw: IpcWireInput, peer: TPeer): Effect.Effect<boolean, IpcError> {
    const message = classifyIpcMessage(raw);
    return message === undefined ? Effect.succeed(false) : Effect.as(this.dispatchMessage(message, peer), true);
  }
  dispatchMessage(message: IpcMessage, peer: TPeer): Effect.Effect<void, IpcError> {
    switch (message.kind) {
      case "response": return Effect.sync(() => this.settleResponse(message.value, peer));
      case "request": return this.dispatchRequest(message.value, peer);
      case "notification": return this.dispatchNotification(message.value, peer);
    }
  }
  disconnect(peer: TPeer, error: IpcError): void {
    this.rejectPending(error, (pendingPeer) => this.samePeer(pendingPeer, peer));
  }
  disconnectAll(error: IpcError): void { this.rejectPending(error, () => true); }
  private settleResponse(response: Ipc.Response, peer: TPeer): void {
    const pending = this.pending.get(response.id);
    if (!pending || !this.samePeer(pending.peer, peer)) return;
    this.pending.delete(response.id);
    Deferred.doneUnsafe(pending.result, response.error
      ? Exit.fail(new IpcRemoteError({ code: response.error.code, message: `IPC error ${response.error.code}: ${response.error.message}`, requestId: response.id, method: pending.method }))
      : Exit.succeed(response.result));
  }
  private dispatchRequest(request: Ipc.Request, peer: TPeer): Effect.Effect<void, IpcError> {
    const send = (frame: Ipc.Response) => Effect.try({ try: () => this.options.send(peer, frame), catch: decodeIpcFailure("response.send") });
    const handler = this.options.onRequest;
    if (!handler) return send(Ipc.createErrorResponse(request.id, 1000,
      this.options.missingRequestHandlerMessage?.(request.method) ?? `peer has no request handler for ${request.method}`));
    return Effect.suspend(() => handler(peer, request.method, request.params,
      (result) => this.options.send(peer, Ipc.createResponse(request.id, result)),
      (method, params) => this.options.send(peer, Ipc.createNotification(method, params)),
    )).pipe(Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause);
      if (Option.isNone(failure)) return Effect.failCause(cause);
      const error = failure.value;
      const message = error._tag === "MachinesFailure" ? error.cause.replace(/^\w*Error: /, "") : error.message;
      return send(Ipc.createErrorResponse(request.id, 1000, message));
    }));
  }
  private dispatchNotification(notification: Ipc.Notification, peer: TPeer): Effect.Effect<void> {
    return Effect.suspend(() => this.options.onNotification?.(peer, notification.method, notification.params) ?? Effect.void).pipe(
      Effect.catchCause((cause) => Effect.logWarning("IPC notification handler failed", Cause.pretty(cause))),
    );
  }
  private rejectPending(error: IpcError, matches: (peer: TPeer) => boolean): void {
    for (const [id, pending] of this.pending) {
      if (!matches(pending.peer)) continue;
      this.pending.delete(id);
      Deferred.doneUnsafe(pending.result, Exit.fail(error));
    }
  }
}
