import { Effect } from "effect";
import { ChannelsFailure, SendAdmissionConflict } from "../errors";
import type { ChannelError } from "../errors";
import type { ChannelStores } from "./stores.js";
import {
  Delivery,
  canonicalDigest,
  type Gateway,
  type LedgerAction,
  type PlainValue,
} from "@openomni/protocol";
import type { createExistingAgentMessaging } from "./messaging/send";
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
  messageId: string;
  handle: Gateway.SendMessageHandle;
  startedAt: number;
  clock: () => number;
  admitReplyGrant: () => void;
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
): string {
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
  if (typeof content !== "string")
    throw new ChannelsFailure({
      operation: "message.transform",
      cause: "message transformed content is not text",
    });
  return content;
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
            })),
        ...(external === undefined ? {} : { inboundTreatment: external.route.decision.inboundTreatment ?? "full_access" }),
        ...(external?.automation?.kind === "action"
          ? { source: external.automation.source, handlerRef: external.automation.handlerRef } : {}),
        ...(external?.automation?.automationId === undefined ? {} : {
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

/** Executes an admitted message; progress survives a later grant/projection failure. */
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
    messaging,
    messageId,
    handle,
    startedAt,
    clock,
  } = context;
  const sessionResult: PlainValue = { status: "executed", handle, delivery: { kind: "session" } };
  const content = transformedContent(intent, sender, send, messageId);
  if (yield* admitExternal(context, content)) return sessionResult;
  if (send.to.kind === "actor") {
    if (messaging === undefined)
      return yield* Effect.die(
        new ChannelsFailure({
          operation: "message.actor_send",
          cause: "actor messaging is not configured",
        }),
      );
    const receipt = yield* messaging.send({
      messageId,
      traceId: intent.action.id,
      senderId: sender.kind === "session" ? sender.id : sender.externalId,
      target: { actorId: send.to.actorId },
      body: content,
      at: startedAt,
      operation: send.deadline === undefined ? "fire_and_forget" : "awaited",
      ...requestSpec(send, intent),
    });
    if (receipt.kind === "denied")
      return yield* Effect.fail(
        new SendAdmissionConflict({ message: `actor send admission changed: ${receipt.code}` }),
      );
    const actorResult: PlainValue = { status: "executed", handle, delivery: { kind: "actor", value: receipt.delivery } };
    return actorResult;
  }
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
  context.admitReplyGrant();
  return sessionResult;
  });
}
