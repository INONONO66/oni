import { timingSafeEqual } from "node:crypto";
import { type Channel, type Gateway, Operational, Outbound, type PlainValue } from "@openomni/protocol";
import { Duration, Effect } from "effect";
import type { DeliveryReceipt } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { newTraceId } from "../../support/trace";
import type { EffectRunner, PublishPort } from "../../types";
import {
  A2A_ERRORS,
  A2A_METHODS,
  A2A_PROTOCOL_VERSION,
  type JsonRpcError,
  JsonRpcRequest,
  type Message,
  MessageSendParams,
  type Task,
  TaskIdParams,
  TERMINAL_STATES,
  textOf,
} from "./types";

/** How long a blocking `message/send` waits for the Resident's answer before returning the task as it stands. */
const A2A_BLOCKING_WAIT_MS = 30_000;

/** How many tasks the door remembers; the oldest finished ones go first, then the oldest open one is canceled. */
const TASK_RETENTION = 1_000;

/** A declared peer this door admits: the bearer it presents and the id it is known by. */
export interface A2APeer {
  readonly id: string;
  readonly token: string;
}

/** Reads the declared peers at request time, so a peer declared mid-run is admitted without a remount. */
export type PeerResolver = () => Promise<readonly A2APeer[]>;

/** What the card says about this agent; the url is the door the request came through. */
export interface A2ACardFacts {
  readonly name: string;
  readonly description: string;
  readonly version: string;
}

interface TaskRecord {
  readonly task: Task;
  readonly peer: string;
  readonly history: Message[];
}

type Waiter = (task: Task) => void;

function tokensEqual(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rpcError(id: PlainValue, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } satisfies JsonRpcError }, { status });
}

function rpcResult(id: PlainValue, result: PlainValue): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * The origin the door is reached at. The daemon binds loopback and sits
 * behind a proxy that terminates TLS, so the forwarded scheme and host
 * name the public door when present; they are read for the card only —
 * the card goes back to whoever set them, so nothing trusts them.
 */
function doorOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const scheme = proto === "https" || proto === "http" ? proto : url.protocol.replace(":", "");
  return `${scheme}://${host === undefined || host === "" ? url.host : host}`;
}

/** The task as a peer reads it, its history cut to `historyLength` (0 omits the history, as the spec says). */
function withHistory(task: Task, historyLength: number | undefined): Task {
  if (historyLength === undefined) return task;
  const { history, ...bare } = task;
  if (historyLength === 0) return bare;
  return { ...bare, history: (history ?? []).slice(-historyLength) };
}

/**
 * The inbound A2A door (#1569 lane 9c): other agents reach the Resident
 * through ordinary ingress with their own actor and tier. A JSON-RPC
 * `message/send` from a declared peer (its bearer, compared in constant
 * time against every declared peer, names it) becomes one inbound message
 * — the context is the conversation, the task one exchange in it — and is
 * answered with the task; `configuration.blocking` waits for the
 * Resident's answer, bounded. The reply door's delivery into the context
 * lands on its newest open task, appends the agent's message and completes
 * it; `tasks/get` reads a task back; `tasks/cancel` cancels one still open.
 * A task is its peer's alone. Streaming and push notifications are
 * declared unsupported. The card is served at the well-known path with the
 * door the request came through as its url. Tasks live in this process: a
 * restart forgets them.
 */
export class A2AAdapter implements Channel.Surface {
  readonly id = "a2a";
  /** The surface contract's config: a peer is declared, not configured. */
  readonly config: Channel.Config = {};
  private handler: Channel.MessageHandler | null = null;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(
    private readonly publish: PublishPort,
    private readonly options: { readonly now: () => number; readonly id: () => string; readonly run: EffectRunner },
    private readonly peers: PeerResolver,
    private readonly card: A2ACardFacts,
  ) {}

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    requireHandler(this.handler, "a2a");
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "a2a door ready",
      context: { tasks: this.tasks.size },
    });
  }

  stop(_traceId: string): void {
    // HTTP calls have no persistent transport; the tasks stay with the process.
  }

  /** The card (GET) or one JSON-RPC call (POST): everything else is not this door's. */
  async handleWebhook(request: Request): Promise<Response> {
    if (request.method === "GET") return this.serveCard(request);
    const traceId = newTraceId(this.options.id);
    const bearer = bearerOf(request);
    const peer = bearer === undefined ? undefined : await this.peerOf(bearer);
    if (peer === undefined) return rpcError(null, A2A_ERRORS.invalidRequest, "Unauthorized", 401);
    const document = await request.text();
    let raw: PlainValue;
    try {
      raw = JSON.parse(document);
    } catch {
      return rpcError(null, A2A_ERRORS.parse, "Parse error");
    }
    const parsed = JsonRpcRequest.safeParse(raw);
    if (!parsed.success) return rpcError(null, A2A_ERRORS.invalidRequest, "Invalid Request");
    const call = parsed.data;
    const id = call.id ?? null;
    if (A2A_METHODS.send.has(call.method)) return this.send(call.params, id, peer, traceId);
    if (A2A_METHODS.get.has(call.method)) return this.get(call.params, id, peer);
    if (A2A_METHODS.cancel.has(call.method)) return this.cancel(call.params, id, peer, traceId);
    if (A2A_METHODS.stream.has(call.method))
      return rpcError(id, A2A_ERRORS.unsupportedOperation, "This operation is not supported");
    if (A2A_METHODS.push.has(call.method))
      return rpcError(id, A2A_ERRORS.pushNotSupported, "Push Notification is not supported");
    return rpcError(id, A2A_ERRORS.methodNotFound, "Method not found");
  }

  /** The reply door's answer: the agent's message on the context's newest open task, completing it. */
  async deliver(
    _externalId: string,
    payload: Outbound.Payload,
    idempotencyKey: string,
    conversation?: Gateway.Conversation,
  ): Promise<DeliveryReceipt> {
    if (payload.kind === "react" || conversation === undefined) return { value: "not_sent" };
    const record = this.openTaskIn(conversation.channelId);
    if (record === undefined) return { value: "not_sent" };
    const message: Message = {
      kind: "message",
      role: "agent",
      parts: [{ kind: "text", text: Outbound.text(payload) }],
      messageId: idempotencyKey,
      taskId: record.task.id,
      contextId: record.task.contextId,
    };
    const history = [...record.history, message];
    const task: Task = {
      ...record.task,
      status: { state: "completed", message, timestamp: new Date(this.options.now()).toISOString() },
      history,
    };
    this.tasks.set(task.id, { ...record, task, history });
    this.wake(task);
    return { value: "sent", externalMessageId: idempotencyKey };
  }

  private async peerOf(bearer: string): Promise<A2APeer | undefined> {
    for (const peer of await this.peers()) if (tokensEqual(bearer, peer.token)) return peer;
    return undefined;
  }

  /** The newest task still open in a context: the one the Resident's answer lands on. */
  private openTaskIn(contextId: string): TaskRecord | undefined {
    let found: TaskRecord | undefined;
    for (const record of this.tasks.values()) {
      if (record.task.contextId === contextId && !TERMINAL_STATES.has(record.task.status.state)) found = record;
    }
    return found;
  }

  private serveCard(request: Request): Response {
    return Response.json({
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: this.card.name,
      description: this.card.description,
      url: `${doorOrigin(request)}/a2a`,
      preferredTransport: "JSONRPC",
      version: this.card.version,
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [
        {
          id: "resident",
          name: this.card.name,
          description: this.card.description,
          tags: ["assistant"],
          inputModes: ["text/plain"],
          outputModes: ["text/plain"],
        },
      ],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
    });
  }

  private async send(params: PlainValue | undefined, id: PlainValue, peer: A2APeer, traceId: string): Promise<Response> {
    const parsed = MessageSendParams.safeParse(params);
    if (!parsed.success) return rpcError(id, A2A_ERRORS.invalidParams, "Invalid params");
    const { message, configuration } = parsed.data;
    const text = textOf(message.parts);
    if (text === "") return rpcError(id, A2A_ERRORS.invalidParams, "Invalid params: no text part");
    const taskId = message.taskId ?? this.options.id();
    const existing = this.tasks.get(taskId);
    // A task is its peer's alone: another peer naming it learns no more than one naming a task that is not there.
    if (message.taskId !== undefined && (existing === undefined || existing.peer !== peer.id))
      return rpcError(id, A2A_ERRORS.taskNotFound, "Task not found");
    if (existing !== undefined && TERMINAL_STATES.has(existing.task.status.state))
      return rpcError(id, A2A_ERRORS.invalidParams, "Invalid params: the task is finished");
    const contextId = existing?.task.contextId ?? message.contextId ?? this.options.id();
    const stamped: Message = { ...message, kind: "message", taskId, contextId };
    const history = [...(existing?.history ?? []), stamped];
    const working: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "working", timestamp: new Date(this.options.now()).toISOString() },
      history,
    };
    this.remember(taskId, { task: working, peer: peer.id, history });
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "a2a message received",
      context: { peer: peer.id, task: taskId, message: message.messageId },
    });
    const settled = configuration?.blocking === true ? this.awaitAnswer(taskId, working) : undefined;
    try {
      await (this.handler as Channel.MessageHandler)({
        sender: { kind: "external", surface: "a2a", externalId: peer.id },
        facts: {
          eventId: message.messageId,
          event: "message",
          surface: "a2a",
          // The context is the conversation: every task a peer opens in it reaches the same session.
          channelId: contextId,
          addressees: [],
          dm: true,
          author: { externalId: peer.id, isBot: true },
          reply: { chain: [], externalConversationId: `a2a:${peer.id}:${contextId}` },
          payload: stamped,
          render: text,
        },
      });
    } catch (error) {
      const failed: Task = { ...working, status: { state: "failed", timestamp: new Date(this.options.now()).toISOString() } };
      this.remember(taskId, { task: failed, peer: peer.id, history });
      this.wake(failed);
      this.publish(Operational.Events.Error, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: "a2a message handler error",
        context: { peer: peer.id, task: taskId, error: error instanceof Error ? error.message : String(error) },
      });
      return rpcResult(id, withHistory(failed, configuration?.historyLength));
    }
    const task = settled === undefined ? working : await settled;
    return rpcResult(id, withHistory(this.tasks.get(taskId)?.task ?? task, configuration?.historyLength));
  }

  /** A blocking send waits for the reply door's delivery, bounded; the task as it stands comes back either way. */
  private awaitAnswer(taskId: string, standing: Task): Promise<Task> {
    let own: Waiter = () => undefined;
    const answered = new Promise<Task>((resolve) => {
      own = resolve;
      const held = this.waiters.get(taskId) ?? new Set<Waiter>();
      held.add(resolve);
      this.waiters.set(taskId, held);
    });
    const expired = this.options
      .run(Effect.sleep(Duration.millis(A2A_BLOCKING_WAIT_MS)))
      .then(() => this.tasks.get(taskId)?.task ?? standing);
    return Promise.race([answered, expired]).finally(() => {
      // Only this call's own waiter leaves: another blocking send on the task keeps waiting.
      const held = this.waiters.get(taskId);
      if (held === undefined) return;
      held.delete(own);
      if (held.size === 0) this.waiters.delete(taskId);
    });
  }

  /** Every blocking send waiting on the task gets it as it now stands. */
  private wake(task: Task): void {
    const held = this.waiters.get(task.id);
    if (held === undefined) return;
    this.waiters.delete(task.id);
    for (const resolve of held) resolve(task);
  }

  private get(params: PlainValue | undefined, id: PlainValue, peer: A2APeer): Response {
    const parsed = TaskIdParams.safeParse(params);
    if (!parsed.success) return rpcError(id, A2A_ERRORS.invalidParams, "Invalid params");
    const record = this.tasks.get(parsed.data.id);
    if (record === undefined || record.peer !== peer.id) return rpcError(id, A2A_ERRORS.taskNotFound, "Task not found");
    return rpcResult(id, withHistory({ ...record.task, history: record.history }, parsed.data.historyLength));
  }

  private cancel(params: PlainValue | undefined, id: PlainValue, peer: A2APeer, traceId: string): Response {
    const parsed = TaskIdParams.safeParse(params);
    if (!parsed.success) return rpcError(id, A2A_ERRORS.invalidParams, "Invalid params");
    const record = this.tasks.get(parsed.data.id);
    if (record === undefined || record.peer !== peer.id) return rpcError(id, A2A_ERRORS.taskNotFound, "Task not found");
    if (TERMINAL_STATES.has(record.task.status.state))
      return rpcError(id, A2A_ERRORS.taskNotCancelable, "Task cannot be canceled");
    const canceled: Task = {
      ...record.task,
      status: { state: "canceled", timestamp: new Date(this.options.now()).toISOString() },
    };
    this.tasks.set(canceled.id, { ...record, task: canceled });
    this.wake(canceled);
    this.publish(Operational.Events.Info, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: "a2a task canceled by its peer",
      context: { peer: peer.id, task: canceled.id },
    });
    return rpcResult(id, canceled);
  }

  /**
   * Bounded memory: the oldest finished task goes when the door holds too
   * many; with none finished, the oldest open task is canceled (its
   * blocking sends woken with that word) and forgotten.
   */
  private remember(taskId: string, record: TaskRecord): void {
    this.tasks.set(taskId, record);
    if (this.tasks.size <= TASK_RETENTION) return;
    for (const [id, held] of this.tasks) {
      if (!TERMINAL_STATES.has(held.task.status.state)) continue;
      this.tasks.delete(id);
      return;
    }
    const oldest = this.tasks.entries().next();
    if (oldest.done === true) return;
    const [id, held] = oldest.value;
    this.tasks.delete(id);
    this.wake({ ...held.task, status: { state: "canceled", timestamp: new Date(this.options.now()).toISOString() } });
    this.publish(Operational.Events.Warn, {
      traceId: newTraceId(this.options.id),
      time: this.options.now(),
      component: "server",
      msg: "a2a door evicted an open task",
      context: { peer: held.peer, task: id, retained: TASK_RETENTION },
    });
  }
}
