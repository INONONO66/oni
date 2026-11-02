import { Effect } from "effect";
import {
  type BusEvent,
  Channel,
  Gateway,
  MessagingEvents,
  type Outbound,
} from "@oni/protocol";
import { type ChannelError, decodeChannelFailure, SendAdmissionConflict } from "../../errors";
import type { KernelDeliveryReceipt } from "../../support/deliver";
import type { ChannelStores } from "../stores.js";
import type { GatewayRouterPorts } from "../message-ports";
import { admitReply } from "./admission";
import { resolveInstance } from "./route";

/**
 * The reply door (#1569): a turn answers the conversation that prompted it.
 * Authority is not a grant but the router's own conversation binding — at
 * inbound admission the router claimed the ingress surface key for the
 * session it routed to (`message-execution.ts`), so the session that owns
 * that key, and only it, may answer there. No budget applies: a reply is
 * never cold outreach. Custody is unchanged: one admission fact per message
 * id and one physical attempt per key through the surface's delivery route.
 */

/** The conversation a delivered prompt came from, as the app folds it from the prompt's recorded origin. */
export interface ConversationBinding {
  readonly surface: string;
  readonly instance?: string;
  readonly externalId: string;
  /** Empty for an anonymous sender admitted by a channel default. */
  readonly actorId: string;
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly dm: boolean;
  readonly threadId?: string;
  /** The account identity that observed the prompt; Owner replies require the declaration's auto-reply grant. */
  readonly receivedBy?: Channel.Identity;
}

/**
 * `draft` (#1569 lane 7): the surface is reachable only through an Owner
 * instance whose declaration does not let the reply door answer on its own;
 * the Resident's answer stays a draft the Owner sends.
 */
type ReplyRefusal = "not_bound" | "no_route" | "draft";

/** The ingress surface key the inbound claimed for its session: the same fold as `automation/input.ts`. */
function bindingSurfaceKey(binding: ConversationBinding): string {
  return Channel.SurfaceKey.fromChannel({
    surface: binding.surface,
    namespace: binding.instance ?? binding.workspaceId ?? binding.surface,
    kind: binding.dm ? "dm" : "channel",
    id: binding.channelId,
    ...(binding.threadId === undefined ? {} : { threadId: binding.threadId }),
  });
}

/** Where the answer lands: the thread or channel the person wrote in; a DM keeps its chat, unthreaded and unquoted. */
function replyConversation(binding: ConversationBinding): Gateway.Conversation {
  if (binding.dm) return { channelId: binding.channelId };
  return {
    channelId: binding.channelId,
    ...(binding.threadId === undefined ? {} : { threadId: binding.threadId }),
    replyToMessageId: binding.messageId,
  };
}

type OutboundMessage = Readonly<{
  messageId: string;
  idempotencyKey: string;
  senderId: string;
  operation: Gateway.MessageOperation;
  payload: Outbound.Payload;
  target: Gateway.DeliveryTarget;
}>;

export interface ReplyPorts {
  readonly stores: ChannelStores;
  readonly transaction: GatewayRouterPorts["transaction"];
  /** The surfaces with a mounted delivery route. */
  readonly routes: () => ReadonlyMap<string, Channel.Instance>;
  /** Owner instance ids whose declaration lets the reply door answer through the account. */
  readonly autoReplies: () => ReadonlySet<string>;
  readonly deliver: (
    message: OutboundMessage,
  ) => KernelDeliveryReceipt | Promise<KernelDeliveryReceipt>;
  readonly publish: BusEvent.Sink["publish"];
}

interface ReplyInput {
  readonly messageId: string;
  readonly traceId: string;
  readonly senderId: string;
  readonly binding: ConversationBinding;
  readonly payload: Outbound.Payload;
  readonly at: number;
}

export interface ReplyMessaging {
  /**
   * The router's verdict before policy evaluation: the sender is the session
   * this router routed the prompt to — it owns the ingress surface key the
   * inbound claimed, or the automation ledger recorded it as the routed
   * target of that inbound — and the surface is reachable; or why not.
   */
  preflight(
    senderId: string,
    binding: ConversationBinding | undefined,
    inReplyTo: string,
  ): ReplyRefusal | undefined;
  send(input: ReplyInput): Effect.Effect<KernelDeliveryReceipt["value"], ChannelError>;
}

/**
 * The delivery target a binding resolves to. A registered endpoint lends its
 * ids; an anonymous sender (admitted by a channel default) is addressed by
 * the binding alone, its ids named after the surface key.
 */
function deliveryTarget(
  stores: ChannelStores,
  binding: ConversationBinding,
  identity: Channel.Identity,
  instance: string,
): Gateway.DeliveryTarget {
  const resolved = stores.actors.resolveEndpoint(
    binding.surface,
    binding.externalId,
    binding.workspaceId,
  );
  const key = bindingSurfaceKey(binding);
  const conversation = replyConversation(binding);
  return {
    actorId: resolved?.identity.id ?? (binding.actorId || `anonymous:${binding.externalId}`),
    endpointId: resolved?.endpoint.id ?? `binding:${key}`,
    channel: binding.surface,
    externalId: binding.externalId,
    identity,
    instance,
    ...(conversation === undefined ? {} : { conversation }),
  };
}

/**
 * A reply leaves through the instance that received the prompt. An Owner
 * account without an auto-replying outbound route drafts; another mounted
 * account never substitutes for it. Non-channel origins can use their sole
 * matching route.
 */
function replyInstance(
  ports: Pick<ReplyPorts, "routes" | "autoReplies">,
  binding: Pick<ConversationBinding, "surface" | "instance" | "receivedBy">,
): { readonly instance: string; readonly identity: Channel.Identity } | "draft" | "no_route" {
  const routes = ports.routes();
  const identity = binding.receivedBy ?? "bot";
  const selected = resolveInstance(routes, binding.surface, identity, binding.instance);
  if ("code" in selected) return identity === "owner" ? "draft" : "no_route";
  if (identity === "owner" && !ports.autoReplies().has(selected.instance)) return "draft";
  return { instance: selected.instance, identity };
}

/**
 * The session an Owner automation routed an inbound to, from the automation
 * ledger's own record (`automation/ledger.ts` writes `target: session:<id>`
 * on the matched decision). An automation target never claims the surface
 * key — that would re-point the conversation's direct routing — so the
 * reply door reads the routed target here instead.
 */
function automationTarget(stores: ChannelStores, inboundId: string): string | undefined {
  const decision = stores.automations.decisions(inboundId)[0];
  const target = decision !== undefined && "target" in decision ? decision.target : undefined;
  return typeof target === "string" && target.startsWith("session:")
    ? target.slice("session:".length)
    : undefined;
}

export function createReplyMessaging(ports: ReplyPorts): ReplyMessaging {
  return {
    preflight(senderId, binding, inReplyTo) {
      if (binding === undefined) return "not_bound";
      const routedTo =
        ports.stores.surfaceKeys.lookup(bindingSurfaceKey(binding)) === senderId ||
        automationTarget(ports.stores, inReplyTo) === senderId;
      if (!routedTo) return "not_bound";
      const selected = replyInstance(ports, binding);
      return typeof selected === "string" ? selected : undefined;
    },
    send: (input) =>
      Effect.gen(function* () {
        const selected = replyInstance(ports, input.binding);
        if (typeof selected === "string")
          return yield* Effect.fail(
            new SendAdmissionConflict({ message: `reply admission changed: ${selected}` }),
          );
        const target = deliveryTarget(ports.stores, input.binding, selected.identity, selected.instance);
        const admission = Gateway.SendInput.parse({
          messageId: input.messageId,
          traceId: input.traceId,
          senderId: input.senderId,
          target: {
            actorId: target.actorId,
            endpointId: target.endpointId,
            surface: target.instance,
            identity: target.identity,
            ...(target.conversation === undefined ? {} : { conversation: target.conversation }),
          },
          operation: "fire_and_forget",
          payload: input.payload,
          at: input.at,
          class: "notify",
        });
        // One admission fact per message id, budget-free, inside the ledger
        // transaction; a replay matches or conflicts before anything is sent.
        yield* ports.transaction(Effect.sync(() => admitReply(ports.stores, admission, target)));
        const delivery = yield* Effect.tryPromise({
          try: async () =>
            ports.deliver({
              messageId: input.messageId,
              idempotencyKey: input.messageId,
              senderId: input.senderId,
              operation: "fire_and_forget",
              payload: input.payload,
              target,
            }),
          catch: decodeChannelFailure("reply.deliver"),
        });
        ports.publish(MessagingEvents.Sent, {
          messageId: input.messageId,
          traceId: input.traceId,
          senderId: input.senderId,
          targetActorId: target.actorId,
          operation: "fire_and_forget",
          grantId: `binding:${bindingSurfaceKey(input.binding)}`,
          endpointId: target.endpointId,
          identity: target.identity,
          time: input.at,
        });
        return delivery.value;
      }),
  };
}
