import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { Gateway, Ingress, Machine, listenForAbort, parseJson, SessionFork, SessionRead } from "@oni/protocol";
import { AutomationRefusedError, GatewayUnavailableError, TransportCapabilityError } from "../errors";
import { z } from "zod";

/** The subset of `WebSocket` this transport uses, so a test can serve its own. */
interface SocketLike {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer | Blob }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

/** A `WebSocket` constructor: the global one unless a caller injects another. */
type SocketConstructor = new (url: string, protocols?: string | string[]) => SocketLike;

interface GatewayChatTransportOptions {
  /** `ws://host:port` — the gateway's WebSocket endpoint. */
  readonly url: string;
  /** Injected entropy (#1245): mints the text-part id on each answered turn. */
  readonly id: () => string;

  readonly protocols?: string | readonly string[];
  /** Injected in tests. Defaults to the platform `WebSocket`. */
  readonly WebSocketImpl?: SocketConstructor;
  readonly onSessionBound?: (chatId: string, sessionId: string) => void;
  /** One deadline for opening the socket and receiving an automation reply. */
  readonly automationTimeoutMs?: number;
}

const serverFrameSchema = z.union([
  Machine.Response,
  Ingress.AutomationResponse,
  // A correlated but malformed reply must reject its waiter, not disappear or reach chat.
  z.object({ requestId: z.string() }).transform(({ requestId }) => ({
    type: "invalid_automation_response" as const, requestId,
  })),
  SessionRead.Response,
  SessionRead.Receipt,
  SessionRead.Bound,
  SessionFork.Forked,
  SessionFork.Refused,
  z.object({
    type: z.literal("message"),
    messageId: z.string(),
    text: z.string(),
    parts: Gateway.MediaPart.array().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string().optional(),
    reason: z.string().optional(),
    sessionId: z.string().optional(),
  }),
]);

type ServerFrame = z.infer<typeof serverFrameSchema>;

function parseFrame(raw: string | ArrayBuffer | Blob): ServerFrame | undefined {
  return typeof raw === "string" ? parseJson(serverFrameSchema, raw) : undefined;
}

/** Wires `stop` to a turn's abort signal; the AI SDK may send a turn without one. */
function stopOnAbort(signal: AbortSignal | undefined, stop: () => void): (() => void) | undefined {
  return signal === undefined ? undefined : listenForAbort(signal, stop);
}

function lastUserText(messages: readonly UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

/** A turn awaiting its terminal frame. */
interface Turn {
  readonly chatId: string;
  readonly socket: SocketLike;
  readonly emit: (chunk: UIMessageChunk) => void;
  readonly close: () => void;
}

interface OutstandingMessage {
  readonly id: string;
  readonly socket: SocketLike;
}

interface SocketConnection {
  readonly socket: SocketLike;
  readonly opened: Promise<SocketLike>;
}

/** Reject every waiter coalesced onto one in-flight session read. */
function rejectWaiters(
  waiters: readonly { readonly reject: (error: Error) => void }[],
  failure: Error,
): void {
  for (const waiter of waiters) waiter.reject(failure);
}

/**
 * A `readSession` was refused because another read for the same session is
 * already in flight with a different cursor. The in-flight read keeps its
 * waiters and still settles; the refused caller must retry after it drains.
 */
export class SessionReadSupersessionError extends Error {
  override readonly name = "SessionReadSupersessionError";
  constructor(sessionId: string) {
    super(`a session read for "${sessionId}" is already in flight with a different cursor`);
  }
}

export interface GatewayChatTransport extends ChatTransport<UIMessage> {
  machineList(): Promise<Extract<Machine.Response, { type: "machine_listed" }>>;
  automationList(): Promise<AutomationReply<"automation_listed">>;
  automationAdd(record: Extract<z.input<typeof Ingress.AutomationRequest>, { type: "automation_add" }>["record"]): Promise<AutomationReply<"automation_added">>;
  automationRemove(id: string): Promise<AutomationReply<"automation_removed">>;
  automationEnable(id: string): Promise<AutomationReply<"automation_enabled">>;
  automationDisable(id: string): Promise<AutomationReply<"automation_disabled">>;
  automationLedger(filter?: Partial<Ingress.AutomationLedgerFilter>): Promise<AutomationReply<"automation_ledger_read">>;
  readSession(sessionId: string, cursor?: SessionRead.Cursor): Promise<SessionRead.Page>;
  subscribeSession(listener: (page: SessionRead.Page) => void): () => void;
  /**
   * Fork a session at a boundary anchor (#1257). Resolves with the gateway's
   * typed answer — `session_forked` or `session_fork_refused` — and rejects
   * only on transport failure (socket drain, no gateway).
   */
  forkSession(request: Omit<SessionFork.Request, "type">): Promise<SessionFork.Response>;
}

type ManagedResponse = Ingress.AutomationResponse | Machine.Response;
type AutomationReply<Type extends ManagedResponse["type"]> =
  Extract<ManagedResponse, { type: Type }>;
type AutomationInput = {
  [Type in Ingress.AutomationRequest["type"]]: Omit<Extract<z.input<typeof Ingress.AutomationRequest>, { type: Type }>, "requestId">;
}[Ingress.AutomationRequest["type"]];

function isAutomationReply<Type extends ManagedResponse["type"]>(
  frame: ManagedResponse,
  type: Type,
): frame is AutomationReply<Type> {
  return frame.type === type;
}

function emptyStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

export function createGatewayChatTransport(
  options: GatewayChatTransportOptions,
): GatewayChatTransport {
  const pending: Turn[] = [];

  const outstanding = new Map<string, OutstandingMessage>();
  const lastChatId = new WeakMap<SocketLike, string>();
  const reads = new Map<
    string,
    {
      readonly socket: SocketLike;
      readonly cursorKey: string;
      readonly waiters: {
        readonly resolve: (page: SessionRead.Page) => void;
        readonly reject: (error: Error) => void;
      }[];
    }
  >();
  const listeners = new Set<(page: SessionRead.Page) => void>();
  const automations = new Map<string, {
    readonly socket: SocketLike;
    readonly waiters: {
      readonly resolve: (frame: ManagedResponse) => void;
      readonly reject: (error: Error) => void;
    }[];
  }>();
  /** FIFO fork waiters keyed by the PARENT session id (#1257). */
  const forks = new Map<
    string,
    {
      readonly socket: SocketLike;
      readonly waiters: {
        readonly resolve: (response: SessionFork.Response) => void;
        readonly reject: (error: Error) => void;
      }[];
    }
  >();

  function settleFork(source: SocketLike, frame: SessionFork.Response): void {
    const parentId = frame.type === "session_forked" ? frame.parentId : frame.sessionId;
    const entry = forks.get(parentId);
    if (entry === undefined || entry.socket !== source) return;
    const waiter = entry.waiters.shift();
    if (entry.waiters.length === 0) forks.delete(parentId);
    waiter?.resolve(frame);
  }

  function settleRead(source: SocketLike, frame: SessionRead.Response): void {
    const pendingRead = reads.get(frame.sessionId);
    if (pendingRead !== undefined && pendingRead.socket !== source) return;
    if (frame.type === "session_gap") {
      source.send(JSON.stringify({ type: "session_read", sessionId: frame.sessionId, limit: 256 }));
      return;
    }
    for (const listener of listeners) listener(frame);
    if (frame.nextRevision !== null) {
      source.send(
        JSON.stringify({
          type: "session_read",
          sessionId: frame.sessionId,
          limit: 256,
          cursor: { revision: frame.nextRevision, epoch: frame.epoch },
        }),
      );
      return;
    }
    reads.delete(frame.sessionId);
    if (pendingRead !== undefined) {
      for (const waiter of pendingRead.waiters) waiter.resolve(frame);
    }
    // A terminal phase on a session-level page is not chat-stream completion:
    // it may describe a previous turn, and the current turn's message frame can
    // arrive after it. Pending chats settle only on their own message/error
    // frames (or socket drain), never on a session read.
  }

  function bindSession(source: SocketLike, frame: SessionRead.Bound): void {
    const chatId = pending.find((turn) => turn.socket === source)?.chatId ?? lastChatId.get(source);
    const result = frame.result;
    if (chatId === undefined || result.status === "blocked_pre") return;
    options.onSessionBound?.(chatId, result.handle.target);
  }

  function settleAutomation(source: SocketLike, frame: Extract<ServerFrame, { requestId: string }>): void {
    const entry = automations.get(frame.requestId);
    if (entry?.socket !== source) return;
    automations.delete(frame.requestId);
    if (frame.type === "invalid_automation_response") {
      rejectWaiters(entry.waiters, new GatewayUnavailableError("Invalid automation response"));
    } else {
      for (const waiter of entry.waiters) waiter.resolve(frame);
    }
  }

  function settle(source: SocketLike, frame: ServerFrame): void {
    if ("requestId" in frame) {
      settleAutomation(source, frame);
      return;
    }
    if (
      frame.type === "session_snapshot" ||
      frame.type === "session_page" ||
      frame.type === "session_gap"
    ) {
      settleRead(source, frame);
      return;
    }
    if (frame.type === "session_bound") {
      bindSession(source, frame);
      return;
    }
    if (frame.type === "session_forked" || frame.type === "session_fork_refused") {
      settleFork(source, frame);
      return;
    }
    // A receipt is only the frozen acceptance ack; session_bound binds.
    if (frame.type === "receipt") return;
    if (frame.type === "error" && frame.sessionId !== undefined) {
      rejectRead(frame.sessionId, new Error(frame.reason ?? frame.message ?? "session read failed"));
      return;
    }
    if (frame.type === "message" || frame.type === "error") settleChat(source, frame);
  }

  function rejectRead(sessionId: string, failure: Error): void {
    const entry = reads.get(sessionId);
    if (entry === undefined) return;
    reads.delete(sessionId);
    rejectWaiters(entry.waiters, failure);
  }

  function settleChat(
    source: SocketLike,
    frame: Extract<ServerFrame, { type: "message" | "error" }>,
  ): void {
    if (frame.type === "message") {
      const chatId =
        pending.find((turn) => turn.socket === source)?.chatId ?? lastChatId.get(source);
      if (chatId !== undefined) {
        outstanding.set(chatId, { id: frame.messageId, socket: source });
      }
    }
    const index = pending.findIndex((turn) => turn.socket === source);
    if (index < 0) return;
    const [turn] = pending.splice(index, 1);
    if (turn === undefined) return;
    if (frame.type === "error") {
      turn.emit({ type: "error", errorText: frame.message ?? frame.reason ?? "gateway error" });
      turn.close();
      return;
    }
    const id = options.id();
    turn.emit({ type: "start" });
    turn.emit({ type: "text-start", id });
    turn.emit({ type: "text-delta", id, delta: frame.text });
    turn.emit({ type: "text-end", id });
    for (const part of frame.parts ?? []) {
      turn.emit({
        type: "file",
        mediaType: part.mime ?? "application/octet-stream",
        url: part.ref,
        // The SDK's file chunks omit filename; providerMetadata survives reduction.
        ...(part.name === undefined ? {} : { providerMetadata: { oni: { filename: part.name } } }),
      });
    }
    turn.emit({ type: "finish" });
    turn.close();
  }

  /** Reject and forget every map entry whose waiters rode the closed socket. */
  function drainEntries<T extends { readonly socket: SocketLike; readonly waiters: readonly { readonly reject: (error: Error) => void }[] }>(
    entries: Map<string, T>,
    source: SocketLike,
    failure: Error,
  ): void {
    for (const [id, entry] of entries) {
      if (entry.socket !== source) continue;
      entries.delete(id);
      rejectWaiters(entry.waiters, failure);
    }
  }

  /** Every in-flight turn on one socket ends when that socket does. */
  function drain(source: SocketLike, errorText?: string): void {
    drainEntries(automations, source, new GatewayUnavailableError(errorText ?? "gateway socket closed"));
    drainEntries(reads, source, new Error(errorText ?? "gateway socket closed"));
    drainEntries(forks, source, new Error(errorText ?? "gateway socket closed"));
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const turn = pending[index];
      if (turn?.socket !== source) continue;
      pending.splice(index, 1);
      if (errorText !== undefined) turn.emit({ type: "error", errorText });
      turn.close();
    }
    for (const [chatId, message] of outstanding) {
      if (message.socket === source) outstanding.delete(chatId);
    }
  }

  const { closeSocket, connectUntilAborted } = createConnection(options, settle, drain);

  async function automation<Type extends ManagedResponse["type"]>(
    input: AutomationInput | Omit<Machine.Request, "requestId">,
    responseType: Type,
  ): Promise<AutomationReply<Type>> {
    const request = (input.type === "machine_list" ? Machine.Request : Ingress.AutomationRequest)
      .parse({ ...input, requestId: options.id() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GatewayUnavailableError("Automation request timed out")), options.automationTimeoutMs ?? 15_000);
    });
    try {
      const live = await Promise.race([connectUntilAborted(undefined), deadline]);
      if (live === undefined) throw new GatewayUnavailableError("gateway socket unavailable");
      const reply = new Promise<ManagedResponse>((resolve, reject) => {
        automations.set(request.requestId, { socket: live, waiters: [{ resolve, reject }] });
        live.send(JSON.stringify(request));
      });
      const response = await Promise.race([reply, deadline]);
      if (response.type === "machine_list_refused") throw new GatewayUnavailableError(response.detail);
      if ("reason" in response) throw new AutomationRefusedError(response);
      if (!isAutomationReply(response, responseType)) {
        throw new GatewayUnavailableError(`Unexpected automation response: ${response.type}`);
      }
      return response;
    } catch (error) {
      throw error instanceof Error ? error : new GatewayUnavailableError(String(error));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      automations.delete(request.requestId);
    }
  }

  return {
    machineList: () => automation({ type: "machine_list" }, "machine_listed"),
    automationList: () => automation({ type: "automation_list" }, "automation_listed"),
    automationAdd: (record) => automation({ type: "automation_add", record }, "automation_added"),
    automationRemove: (id) => automation({ type: "automation_remove", id }, "automation_removed"),
    automationEnable: (id) => automation({ type: "automation_enable", id }, "automation_enabled"),
    automationDisable: (id) => automation({ type: "automation_disable", id }, "automation_disabled"),
    automationLedger: (filter = {}) => automation({ ...filter, type: "automation_ledger" }, "automation_ledger_read"),
    async readSession(sessionId, cursor) {
      const live = await connectUntilAborted(undefined);
      if (live === undefined) throw new GatewayUnavailableError("gateway socket unavailable");
      const cursorKey = cursor === undefined ? "" : `${cursor.revision}:${cursor.epoch}`;
      const inFlight = reads.get(sessionId);
      if (inFlight !== undefined) {
        if (inFlight.cursorKey !== cursorKey) {
          throw new SessionReadSupersessionError(sessionId);
        }
        return new Promise<SessionRead.Page>((resolve, reject) => {
          inFlight.waiters.push({ resolve, reject });
        });
      }
      return new Promise<SessionRead.Page>((resolve, reject) => {
        reads.set(sessionId, { socket: live, cursorKey, waiters: [{ resolve, reject }] });
        try {
          live.send(
            JSON.stringify(
              SessionRead.Request.parse({
                type: "session_read",
                sessionId,
                limit: 256,
                cursor,
              }),
            ),
          );
        } catch (error) {
          reads.delete(sessionId);
          reject(error);
        }
      });
    },
    async forkSession(request) {
      const live = await connectUntilAborted(undefined);
      if (live === undefined) throw new GatewayUnavailableError("gateway socket unavailable");
      const entry = forks.get(request.sessionId) ?? { socket: live, waiters: [] };
      if (entry.socket !== live) throw new GatewayUnavailableError("gateway socket replaced");
      return new Promise<SessionFork.Response>((resolve, reject) => {
        entry.waiters.push({ resolve, reject });
        forks.set(request.sessionId, entry);
        try {
          live.send(JSON.stringify(SessionFork.Request.parse({ type: "session_fork", ...request })));
        } catch (error) {
          entry.waiters.pop();
          if (entry.waiters.length === 0) forks.delete(request.sessionId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    subscribeSession(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async sendMessages({ trigger, chatId, messages, abortSignal }) {
      if (trigger === "regenerate-message") {
        throw new TransportCapabilityError("gateway transport does not support regeneration");
      }
      if (abortSignal?.aborted) return emptyStream();

      const text = lastUserText(messages);
      const live = await connectUntilAborted(abortSignal);
      if (live === undefined) return emptyStream();

      const outstandingMessage = outstanding.get(chatId);
      const replyToId = outstandingMessage?.socket === live ? outstandingMessage.id : undefined;
      if (outstandingMessage !== undefined && outstandingMessage.socket !== live) {
        outstanding.delete(chatId);
      }

      let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
      let closed = false;
      let removeAbortListener: (() => void) | undefined;
      const turn: Turn = {
        chatId,
        socket: live,
        emit: (chunk) => controller?.enqueue(chunk),
        close: () => {
          if (closed) return;
          closed = true;
          removeAbortListener?.();
          controller?.close();
        },
      };

      const stopTurn = () => {
        const index = pending.indexOf(turn);
        if (index >= 0) pending.splice(index, 1);
        turn.close();
        closeSocket(live, "gateway socket closed by another turn");
      };

      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          controller = streamController;
        },
        cancel() {
          if (closed) return;
          closed = true;
          removeAbortListener?.();
          const index = pending.indexOf(turn);
          if (index >= 0) pending.splice(index, 1);
          closeSocket(live, "gateway socket closed by another turn");
        },
      });

      removeAbortListener = stopOnAbort(abortSignal, stopTurn);
      if (abortSignal?.aborted) return stream;

      pending.push(turn);
      let sent = false;
      try {
        const eventId = options.id();
        live.send(JSON.stringify(replyToId === undefined ? { eventId, text } : { eventId, text, replyToId }));
        sent = true;
      } finally {
        if (!sent) closeSocket(live);
      }
      lastChatId.set(live, chatId);
      if (replyToId !== undefined) outstanding.delete(chatId);

      return stream;
    },

    reconnectToStream() {
      return Promise.resolve(null);
    },
  };
}

function createConnection(
  options: GatewayChatTransportOptions,
  settle: (source: SocketLike, frame: ServerFrame) => void,
  drain: (source: SocketLike, errorText?: string) => void,
) {
  const Socket: SocketConstructor = options.WebSocketImpl ?? globalThis.WebSocket;

  let socket: SocketLike | undefined;
  let opening: { readonly socket: SocketLike; readonly promise: Promise<SocketLike> } | undefined;
  function closeSocket(source: SocketLike, errorText?: string): void {
    if (socket === source) socket = undefined;
    drain(source, errorText);
    source.close();
  }

  function connect(): SocketConnection {
    const live = socket;
    if (live !== undefined && (live.readyState === 0 || live.readyState === 1)) {
      return {
        socket: live,
        opened: opening?.socket === live ? opening.promise : Promise.resolve(live),
      };
    }
    const next =
      options.protocols === undefined
        ? new Socket(options.url)
        : new Socket(
            options.url,
            typeof options.protocols === "string" ? options.protocols : [...options.protocols],
          );
    socket = next;
    next.addEventListener("message", (event) => {
      const frame = parseFrame(event.data);
      if (frame !== undefined) settle(next, frame);
    });
    next.addEventListener("close", () => {
      if (socket === next) socket = undefined;
      if (opening?.socket === next) opening = undefined;
      drain(next, "gateway socket closed unexpectedly");
    });
    next.addEventListener("error", () =>
      closeSocket(next, `gateway socket failed: ${options.url}`),
    );
    let settled = false;
    const promise = new Promise<SocketLike>((resolve, reject) => {
      next.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        if (opening?.socket === next) opening = undefined;
        resolve(next);
      });
      next.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        if (opening?.socket === next) opening = undefined;
        reject(new Error(`gateway socket failed: ${options.url}`));
      });
      next.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        reject(new Error(`gateway socket closed before opening: ${options.url}`));
      });
    });
    opening = { socket: next, promise };
    return { socket: next, opened: promise };
  }

  async function connectUntilAborted(
    abortSignal: AbortSignal | undefined,
  ): Promise<SocketLike | undefined> {
    const connection = connect();
    if (abortSignal === undefined) return connection.opened;

    let settleAbort: (() => void) | undefined;
    const aborted = new Promise<undefined>((resolve) => {
      settleAbort = () => resolve(undefined);
    });
    const abort = () => {
      settleAbort?.();
      closeSocket(connection.socket);
    };
    const detach = listenForAbort(abortSignal, abort);

    try {
      return await Promise.race([connection.opened, aborted]);
    } finally {
      detach();
    }
  }

  return { closeSocket, connectUntilAborted };
}
