import { Effect } from "effect";
import { decodeChannelFailure, type ChannelError } from "../../errors";
import type { z } from "zod";
import {
  Gateway,
  MessagingEvents,
  canonicalKey,
  type BusEvent,
  type Outbound,
  type SessionTransition,
} from "@openomni/protocol";
import type { GatewayRouterPorts } from "../message-ports.js";
import type { KernelDeliveryReceipt } from "../../support/deliver";
import { authorizeSend } from "./authorize";
import { admitSend } from "./admission";

type DeliveryTarget = Gateway.DeliveryTarget;
type MessageDenialCode = Gateway.MessageDenialCode;
const SendInput = Gateway.SendInput;
type SendInput = z.infer<typeof SendInput>;
type SendReceipt = Gateway.SendReceipt;
type SendAuthorityInput = Parameters<typeof authorizeSend>[1];
type AuthorizedSend = Parameters<typeof admitSend>[1];

type OutboundMessage = Readonly<{
  messageId: string;
  idempotencyKey: string;
  senderId: string;
  operation: Gateway.MessageOperation;
  payload: Outbound.Payload;
  target: DeliveryTarget;
  requestId?: string;
}>;

type MessagingPorts = Readonly<{
  stores: import("../stores.js").ChannelStores;
  requests: GatewayRouterPorts["requests"];
  transaction: GatewayRouterPorts["transaction"];
  /** Delivery owners reconcile retries using the stable idempotency key. */
  deliver: (message: OutboundMessage) => KernelDeliveryReceipt | Promise<KernelDeliveryReceipt>;
  publish: BusEvent.Sink["publish"];
}> &
  Pick<NonNullable<GatewayRouterPorts["messaging"]>, "grants" | "budgets">;

type ExistingAgentMessaging = Readonly<{
  preflight: (input: SendAuthorityInput) => MessageDenialCode | undefined;
  send: (input: SendInput) => Effect.Effect<SendReceipt, ChannelError>;
}>;

/** Kernel records the original action suspension before the physical effect. */
function openSendRequest(
  input: SendInput,
  target: DeliveryTarget,
  ports: MessagingPorts,
): Effect.Effect<SessionTransition.Request | undefined, ChannelError> {
  if (input.operation !== "awaited") return Effect.succeed(undefined);
  const spec = input.requestSpec as NonNullable<SendInput["requestSpec"]>;
  const recorded = ports.requests
    .list()
    .find(
      (candidate) =>
        candidate.requestId === spec.requestId && candidate.sessionId === spec.sessionId,
    );
  return ports.requests.open({
    ...spec,
    correlation: {
      ...spec.correlation,
      endpointId: target.endpointId,
      replyToMessageId: input.messageId,
    },
    at: recorded?.createdAt ?? input.at,
  });
}

/** Every retry reaches the physical driver's stable idempotency key. IDs are not receipts. */
function deliverSend(
  input: SendInput,
  target: DeliveryTarget,
  request: SessionTransition.Request | undefined,
  ports: MessagingPorts,
): Effect.Effect<{
  readonly request: SessionTransition.Request | undefined;
  readonly value: "accepted" | "rejected" | "unknown";
  readonly externalMessageId?: string;
}, ChannelError> {
  return Effect.gen(function* () {
  const delivery = yield* Effect.tryPromise({ try: async () => ports.deliver({
    messageId: input.messageId,
    idempotencyKey: input.messageId,
    senderId: input.senderId,
    operation: input.operation,
    payload: input.payload,
    target,
    ...(request === undefined ? {} : { requestId: request.requestId }),
  }), catch: decodeChannelFailure("message.deliver") });
  const value = delivery.value;
  if (request === undefined) return { request, value, ...(
    delivery.externalMessageId === undefined ? {} : { externalMessageId: delivery.externalMessageId }
  ) };
  const recorded = yield* ports.requests.receipt({
    inputId: canonicalKey([
      input.messageId,
      "delivery",
      value,
      delivery.externalMessageId ?? null,
      input.at,
    ]),
    requestId: request.requestId,
    sessionId: request.sessionId,
    sourceActionId: request.requestId,
    ...(delivery.externalMessageId === undefined
      ? {}
      : { externalMessageId: delivery.externalMessageId }),
    value,
    at: input.at,
  });
  return { request: recorded, value, ...(
    delivery.externalMessageId === undefined ? {} : { externalMessageId: delivery.externalMessageId }
  ) };
  });
}

function recordSent(
  authorization: AuthorizedSend,
  delivered: Effect.Success<ReturnType<typeof deliverSend>>,
  ports: MessagingPorts,
): SendReceipt {
  const { input, target, grant } = authorization;
  const request = delivered.request;
  const delivery = delivered.value;
  const externalMessageId = delivered.externalMessageId;
  ports.publish(MessagingEvents.Sent, {
    messageId: input.messageId,
    traceId: input.traceId,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operation: input.operation,
    grantId: grant.id,
    endpointId: target.endpointId,
    ...(request === undefined ? {} : { requestId: request.requestId }),
    time: input.at,
  });
  if (request !== undefined) {
    return {
      kind: "sent",
      operation: "awaited",
      delivery,
      ...(externalMessageId === undefined ? {} : { externalMessageId }),
      messageId: input.messageId,
      senderId: input.senderId,
      grantId: grant.id,
      target,
      request,
      at: input.at,
    };
  }
  return {
    kind: "sent",
    operation: "fire_and_forget",
    delivery,
    ...(externalMessageId === undefined ? {} : { externalMessageId }),
    messageId: input.messageId,
    senderId: input.senderId,
    grantId: grant.id,
    target,
    at: input.at,
  };
}

/** Grant first, transactional admission/request opening second, physical delivery last. */
export function createExistingAgentMessaging(ports: MessagingPorts): ExistingAgentMessaging {
  function deny(input: SendInput, code: MessageDenialCode, reason: string): SendReceipt {
    ports.publish(MessagingEvents.Denied, {
      messageId: input.messageId,
      traceId: input.traceId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      code,
      time: input.at,
    });
    return {
      kind: "denied",
      code,
      messageId: input.messageId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      reason,
      at: input.at,
    };
  }

  function send(rawInput: SendInput): Effect.Effect<SendReceipt, ChannelError> {
    return Effect.gen(function* () {
    const input = SendInput.parse(rawInput);
    const checked = authorizeSend(ports.stores, input, ports.grants());
    if (!checked.ok) return deny(input, checked.code, checked.reason);
    const authorization = { input, target: checked.target, grant: checked.grant };
    const { target } = authorization;
    // No promise may escape the admission/debit/request write unit.
    const opened = yield* ports.transaction(Effect.gen(function* () {
      const admission = admitSend(ports.stores, authorization, ports, deny);
      if ("kind" in admission) return { denied: admission };
      return { request: yield* openSendRequest(input, target, ports) };
    }));
    if (opened.denied !== undefined) return opened.denied;
    const request = yield* deliverSend(input, target, opened.request, ports);
    return recordSent(authorization, request, ports);
    });
  }

  return {
    preflight(input: SendAuthorityInput) {
      const checked = authorizeSend(ports.stores, input, ports.grants());
      return checked.ok ? undefined : checked.code;
    },
    send,
  };
}
