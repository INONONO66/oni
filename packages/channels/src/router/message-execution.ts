import { Effect } from "effect";
import { ChannelsFailure, SendAdmissionConflict } from "../errors";
import type { ChannelError } from "../errors";
import type { ChannelStores } from "./stores.js";
import {
  Delivery,
  Outbound,
  canonicalDigest,
  type Gateway,
  type LedgerAction,
  type PlainValue,
} from "@oni/protocol";
import type { createExistingAgentMessaging } from "./messaging/send";
import type { ReplyMessaging } from "./messaging/reply";
import type { externalMessage } from "./external-message";
import type { GatewayRouterPorts } from "./message-ports";
import { answerNativeRequest, openNativeRequest } from "./request/native";
import { executeRequestRoute, requireRoutedDecision } from "./routing-execution";

interface MessageContext {
  stores: ChannelStores;
  sender: Gateway.IngestSender;
  send: Gateway.SendMessage;
  prepared: Effect.Success<ReturnType<GatewayRouterPorts["prepare"]>>;
  external: Effect.Success<ReturnType<typeof externalMessage>> | undefined;
  ports: GatewayRouterPorts;
  messaging: ReturnType<typeof createExistingAgentMessaging> | undefined;
  reply: ReplyMessaging | undefined;
  messageId: string;
  handle: Gateway.SendMessageHandle;
  startedAt: number;
  clock: () => number;
}

interface MessageProgress {
  commitMs: number;
  committed: Delivery.Row | undefined;
}

function transformedContent(
  intent: LedgerAction.Receipt,
  sender: Gateway.IngestSender,
  send: Gateway.SendMessage,
  messageId: string,
): Outbound.Payload {
  if (sender.kind === "session" && intent.action.sessionId !== sender.id)
    throw new ChannelsFailure({
      operation: "message.transform",
      cause: "authenticated session sender mismatch",
    });
  const stored = intent.action.intent.value;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored))
    throw new ChannelsFailure({
      operation: "message.transform",
      cause: "message intent is not an object",
    });
  const transformed = stored.value;
  if (transformed === null || typeof transformed !== "object" || Array.isArray(transformed))
    throw new ChannelsFailure({
      operation: "message.transform",
      cause: "message intent value is not an object",
    });
  const { content, ...routing } = transformed;
  const { content: _content, ...originalRouting } = { messageId, sender, ...send };
  if (canonicalDigest(routing) !== canonicalDigest(originalRouting))
    throw new ChannelsFailure({
      operation: "message.transform",
      cause: "message routing transform requires readmission",
    });
  if (typeof content === "string") return Outbound.payload(content);
  const payload = Outbound.Payload.safeParse(content);
  if (!payload.success)
    throw new ChannelsFailure({
      operation: "message.transform",
      cause: "message transformed content is neither text nor an outbound payload",
    });
  return payload.data;
}

/** The conversation a person wrote in, kept on the prompt origin so the answer can go back there. */
/** The external origin's channel facts: the instance that observed the message and the conversation it came from. */
function originConversation(
  external: MessageContext["external"],
): { readonly receivedBy?: "bot" | "owner"; readonly conversation?: PlainValue } {
  if (external === undefined) return {};
  const { facts } = external;
  return {
    // #1600 lane R2: which instance observed the message decides which one answers a DM.
    ...(facts.receivedBy === undefined ? {} : { receivedBy: facts.receivedBy }),
    conversation: {
      channelId: facts.channelId,
      // #1600 lane R2: a button tap answers the message the button was on, not the tap's own id.
      messageId: facts.postback?.messageRef ?? facts.eventId,
      dm: facts.dm,
      ...(facts.workspaceId === undefined ? {} : { workspaceId: facts.workspaceId }),
      ...(facts.reply?.threadId === undefined ? {} : { threadId: facts.reply.threadId }),
    },
  };
}

/** The gateway's actor target as the messaging seam's target: surface pin and conversation carried as given. */
export function actorTarget(
  to: Extract<Gateway.SendMessage["to"], { kind: "actor" }>,
): Gateway.MessageTarget {
  return {
    actorId: to.actorId,
    ...(to.surface === undefined ? {} : { surface: to.surface }),
    ...(to.conversation === undefined ? {} : { conversation: to.conversation }),
    ...(to.as === undefined ? {} : { identity: to.as }),
  };
}

function deliveryAdmission(
  context: MessageContext,
  intent: LedgerAction.Receipt,
  content: string,
  commitAt: number,
): Delivery.Commit {
  const { sender, send, prepared, messageId, external } = context;
  return {
    id: messageId,
    sessionId: prepared.target,
    kind: external?.automation?.kind ?? (send.type === "message" ? "prompt" : send.type),
    content,
    ...(external?.parts === undefined ? {} : { parts: external.parts }),
    createdAt: commitAt,
    parentActionId: null,
    ...(prepared.sender === undefined ? {} : { sender: prepared.sender }),
    ...(prepared.createSession === undefined ? {} : { createSession: prepared.createSession }),
    ...(prepared.limits === undefined ? {} : { limits: prepared.limits }),
    origin: {
      encodingVersion: 1,
      value: {
        ...(prepared.origin ??
        (sender.kind === "session"
          ? Delivery.MessageOrigin.parse({
              kind: "message",
              messageId,
              senderSessionId: sender.id,
              sourceActionId: intent.action.id,
              ...(send.replyTo === undefined ? {} : { replyTo: send.replyTo }),
              ...(send.deadline === undefined ? {} : { deadline: send.deadline }),
            })
          : {
              kind: "external",
              messageId,
              surface: sender.surface,
              externalId: sender.externalId,
              actorId: external?.event.meta?.actor?.actorId ?? "",
              ...originConversation(external),
            })),
        ...(external === undefined ? {} : { inboundTreatment: external.route.decision.inboundTreatment ?? "full_access" }),
        ...(external?.automation?.kind === "action"
          ? { source: external.automation.source, handlerRef: external.automation.handlerRef } : {}),
        ...(external?.automation?.automationId === undefined ||
          external.automation.automationId.startsWith("granted-direct:") ? {} : {
          automation: {
            id: external.automation.automationId,
            newSession: external.automation.newSession ?? false,
            ...(external.automation.instructions === undefined ? {} : { instructions: external.automation.instructions }),
          },
        }),
      },
    },
  };
}

function requestSpec(send: MessageContext["send"], intent: LedgerAction.Receipt) {
  if (send.deadline === undefined) return {};
  return { requestSpec: {
    requestId: intent.action.id, sessionId: intent.action.sessionId, allowedActions: ["report_result" as const],
    expectedResponders: send.to.kind === "actor" ? [send.to.actorId] : [],
    resolution: "first" as const, threshold: 1, deadline: send.deadline,
  } };
}

function admitExternal(context: MessageContext, content: string) {
  return Effect.gen(function* () {
    const external = context.external;
    if (external === undefined) return false;
    const decision = requireRoutedDecision(external.route.decision);
    yield* executeRequestRoute(context.stores, external.route, decision,
      context.ports.requests, content, context.clock());
    if (external.automation?.automationId === undefined ||
        external.automation.automationId.startsWith("granted-direct:"))
      context.stores.surfaceKeys.claim(external.surfaceKey, context.prepared.target);
    return external.route.requestExecution.kind === "request";
  });
}

/**
 * The reply door (#1569): the binding the app folded from the named prompt,
 * already verified against the surface-key store at preflight; its absence
 * here means admission changed under the send.
 */
function executeReply(
  context: MessageContext,
  intent: LedgerAction.Receipt,
  payload: Outbound.Payload,
): Effect.Effect<PlainValue, ChannelError> {
  const { sender, prepared, messageId, handle, startedAt } = context;
  const binding = prepared.binding;
  if (context.reply === undefined || binding === undefined || sender.kind !== "session")
    return Effect.fail(new SendAdmissionConflict({ message: "reply admission changed: not_bound" }));
  return context.reply
    .send({ messageId, traceId: intent.action.id, senderId: sender.id, binding, payload, at: startedAt })
    .pipe(
      Effect.map((value): PlainValue => ({ status: "executed", handle, delivery: { kind: "actor", value } })),
    );
}

/** An actor send through the send kernel: a denial after preflight is a typed admission conflict. */
function executeActorSend(
  context: MessageContext,
  to: Extract<Gateway.SendMessage["to"], { kind: "actor" }>,
  intent: LedgerAction.Receipt,
  payload: Outbound.Payload,
): Effect.Effect<PlainValue, ChannelError> {
  const { sender, send, prepared, messaging, messageId, handle, startedAt } = context;
  if (messaging === undefined)
    return Effect.die(
      new ChannelsFailure({ operation: "message.actor_send", cause: "actor messaging is not configured" }),
    );
  return messaging
    .send({
      messageId,
      traceId: intent.action.id,
      senderId: sender.kind === "session" ? sender.id : sender.externalId,
      target: actorTarget(to),
      payload,
      at: startedAt,
      operation: send.deadline === undefined ? "fire_and_forget" : "awaited",
      ...(prepared.ownerOrigin === undefined ? {} : { ownerOrigin: prepared.ownerOrigin }),
      // #1569 lane 8: the Owner's approval of the invocation rides the send as a fact.
      ...(send.consented === true ? { consented: true } : {}),
      ...requestSpec(send, intent),
    })
    .pipe(
      Effect.flatMap((receipt) =>
        receipt.kind === "denied"
          ? Effect.fail(new SendAdmissionConflict({ message: `actor send admission changed: ${receipt.code}` }))
          : Effect.succeed<PlainValue>({
              status: "executed",
              handle,
              delivery: {
                kind: "actor",
                value: receipt.delivery,
                ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
              },
            }),
      ),
    );
}

/** Executes an admitted message; commit progress survives a failure after the commit (the executor's receipt reads it). */
export function executeMessage(
  context: MessageContext,
  progress: MessageProgress,
  intent: LedgerAction.Receipt,
): Effect.Effect<PlainValue, ChannelError> {
  return Effect.gen(function* () {
  const {
    sender,
    send,
    prepared,
    ports,
    messageId,
    handle,
    startedAt,
    clock,
  } = context;
  const sessionResult: PlainValue = { status: "executed", handle, delivery: { kind: "session" } };
  const payload = transformedContent(intent, sender, send, messageId);
  const content = Outbound.text(payload);
  if (yield* admitExternal(context, content)) return sessionResult;
  if (send.to.kind === "origin") return yield* executeReply(context, intent, payload);
  if (send.to.kind === "actor") return yield* executeActorSend(context, send.to, intent, payload);
  if (yield* answerNativeRequest(ports.requests, sender, prepared.origin, content, clock()))
    return sessionResult;
  const commitAt = clock();
  const admission = deliveryAdmission(context, intent, content, commitAt);
  yield* openNativeRequest(
    ports.requests,
    intent,
    sender,
    send,
    prepared.target,
    startedAt,
    admission,
  );
  const row = yield* ports.delivery.commit(admission);
  progress.commitMs = clock() - commitAt;
  progress.committed = row;
  return sessionResult;
  });
}
