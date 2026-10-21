import type { PlainValue } from "@oni/protocol";
import { ChannelsFailure, DeliveryNotSent } from "../../errors";
import { type DeliveryReceipt, DeliveryReconciliation, deliverKeyed } from "../../support/deliver";
import type { PublishPort } from "../../types";
import {
  AgentCard,
  type JsonRpcError,
  JsonRpcResponse,
  Message,
  type MessageSendParams,
  Task,
  type TaskIdParams,
} from "./types";

/** How long one call to a peer may take before its outcome is unknown: the request may have landed. */
const A2A_TIMEOUT_MS = 30_000;

/** Failures raised before any byte left this host: nothing was sent. */
const NEVER_LEFT = new Set(["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const NEVER_LEFT_PATTERN = /CERT|TLS|SSL/;

/** The agent card's well-known path, and the older one some peers still serve. */
const CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"] as const;

/** The one HTTP call the client makes; injected so tests script the peer and production hands in `fetch`. */
export type A2AFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
    /** Never followed: a redirect is the peer's refusal, and the bearer goes nowhere the Owner did not declare. */
    readonly redirect: "manual";
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * What reading a peer's card came to: the card, none at either well-known
 * path, or a card naming an endpoint outside the declared base — refused,
 * since the bearer goes nowhere the Owner did not declare.
 */
export type A2ACardRead =
  | { readonly kind: "card"; readonly card: AgentCard }
  | { readonly kind: "none" }
  | { readonly kind: "foreign"; readonly url: string };

/** What the peer answered a JSON-RPC call with, read into the two shapes A2A allows, or its refusal. */
export type A2AAnswer =
  | { readonly kind: "task"; readonly task: Task }
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "error"; readonly error: JsonRpcError };

function failureCode(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: string | number }).code;
  return typeof code === "string" ? code : undefined;
}

function neverLeft(error: Error): boolean {
  const code = failureCode(error);
  return code !== undefined && (NEVER_LEFT.has(code) || NEVER_LEFT_PATTERN.test(code));
}

/** The declared base without its trailing slashes, so a well-known path appends cleanly (no regex: the base is library input). */
function withoutTrailingSlashes(base: string): string {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end -= 1;
  return base.slice(0, end);
}

/** The card's endpoint shares the declared base's origin: scheme, host and port. */
function withinDeclared(endpoint: string, base: string): boolean {
  try {
    return new URL(endpoint).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * The outbound half of A2A (#1569 lane 9c): discovery of a peer's card, one
 * `message/send` per idempotency key under the same custody as every
 * platform send (never a redirect followed; a 5xx or a lost answer is
 * `unknown` and never re-sent; any other status, a JSON-RPC error and a
 * request that never left are `not_sent`), and `tasks/get` for a task the
 * peer is still working on. The bearer is the declared peer's own.
 */
export class A2AClient {
  private readonly outbound = new DeliveryReconciliation();
  private readonly cards = new Map<string, AgentCard>();

  constructor(
    private readonly deps: {
      readonly fetch: A2AFetch;
      readonly publish: PublishPort;
      readonly now: () => number;
      readonly id: () => string;
      readonly timeoutMs?: number;
    },
  ) {}

  /**
   * The peer's card, read once per base URL and kept. Never throws: a GET
   * that failed, however it failed, is no card. A card whose url leaves the
   * declared base's origin is refused and not kept.
   */
  async card(base: string, token: string): Promise<A2ACardRead> {
    const known = this.cards.get(base);
    if (known !== undefined) return { kind: "card", card: known };
    for (const path of CARD_PATHS) {
      const answered = await this.call("GET", `${withoutTrailingSlashes(base)}${path}`, token);
      if (answered === undefined || answered.status !== 200) continue;
      const parsed = AgentCard.safeParse(this.parse(answered.body));
      if (!parsed.success) continue;
      if (!withinDeclared(parsed.data.url, base)) return { kind: "foreign", url: parsed.data.url };
      this.cards.set(base, parsed.data);
      return { kind: "card", card: parsed.data };
    }
    return { kind: "none" };
  }

  /** One `message/send` per key: the receipt is the custody fact, the answer the peer's word when the call went through. */
  async send(
    endpoint: string,
    token: string,
    params: MessageSendParams,
    idempotencyKey: string,
  ): Promise<{ readonly receipt: DeliveryReceipt; readonly answer?: A2AAnswer }> {
    let answer: A2AAnswer | undefined;
    const receipt = await deliverKeyed(
      this.outbound,
      idempotencyKey,
      async () => {
        const answered = await this.rpc(endpoint, token, "message/send", params, idempotencyKey);
        answer = answered;
        if (answered.kind === "error")
          throw new DeliveryNotSent({ operation: "a2a.send", cause: `${answered.error.code}: ${answered.error.message}` });
        return { accepted: true, externalMessageId: answered.kind === "task" ? answered.task.id : answered.message.messageId };
      },
      neverLeft,
      this.deps.publish,
      { now: this.deps.now, id: this.deps.id },
    );
    return answer === undefined ? { receipt } : { receipt, answer };
  }

  /** The task as the peer holds it now; a refusal is the peer's word. */
  async getTask(endpoint: string, token: string, params: TaskIdParams): Promise<A2AAnswer> {
    return this.rpc(endpoint, token, "tasks/get", params, this.deps.id());
  }

  private async rpc(
    endpoint: string,
    token: string,
    method: string,
    params: MessageSendParams | TaskIdParams,
    id: string,
  ): Promise<A2AAnswer> {
    const answered = await this.call("POST", endpoint, token, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    if (answered === undefined) throw new ChannelsFailure({ operation: `a2a.${method}`, cause: "no answer" });
    // The peer had the request before it failed: it may have acted.
    if (answered.status >= 500) throw new ChannelsFailure({ operation: `a2a.${method}`, cause: `HTTP ${answered.status}` });
    if (answered.status < 200 || answered.status >= 300)
      throw new DeliveryNotSent({ operation: `a2a.${method}`, cause: `HTTP ${answered.status}` });
    const response = JsonRpcResponse.safeParse(this.parse(answered.body));
    if (!response.success) throw new ChannelsFailure({ operation: `a2a.${method}`, cause: "the answer is not JSON-RPC" });
    if (response.data.error !== undefined) return { kind: "error", error: response.data.error };
    const task = Task.safeParse(response.data.result);
    if (task.success) return { kind: "task", task: task.data };
    const message = Message.safeParse(response.data.result);
    if (message.success) return { kind: "message", message: message.data };
    throw new ChannelsFailure({ operation: `a2a.${method}`, cause: "the result is neither a task nor a message" });
  }

  /** One HTTP call; undefined when a GET for a card failed in any way (the card is optional, a send is not: its failure is classified). */
  private async call(
    method: "GET" | "POST",
    url: string,
    token: string,
    body?: string,
  ): Promise<{ readonly status: number; readonly body: string } | undefined> {
    try {
      const answered = await this.deps.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? A2A_TIMEOUT_MS),
        redirect: "manual",
      });
      return { status: answered.status, body: await answered.text() };
    } catch (error) {
      if (method === "GET") return undefined;
      throw error;
    }
  }

  private parse(text: string): PlainValue | undefined {
    try {
      const parsed: PlainValue = JSON.parse(text);
      return parsed;
    } catch {
      return undefined;
    }
  }
}
