import { Effect } from "effect";
import { ChannelsFailure } from "../../errors";
import type { ChannelError } from "../../errors";
import {
  SessionTransition,
  type Gateway,
  type LedgerAction,
  type Delivery,
  type PlainValue,
} from "@oni/protocol";
import type { GatewayRouterPorts } from "../message-ports";

export function answerNativeRequest(
  requests: GatewayRouterPorts["requests"],
  sender: Gateway.IngestSender,
  origin: PlainValue | undefined,
  content: string,
  at: number,
): Effect.Effect<boolean, ChannelError> {
  return Effect.gen(function* () {
  const parsed = SessionTransition.OutboundMessage.safeParse(origin);
  if (!parsed.success) return false;
  const message = parsed.data;
  if (
    sender.kind !== "session" ||
    sender.id !== message.sourceSessionId ||
    content !== message.content
  )
    return yield* Effect.fail(
      new ChannelsFailure({ operation: "native.answer", cause: "native reply binding mismatch" }),
    );
  const request = requests.list().find((candidate) => candidate.requestId === message.requestId);
  if (request === undefined || request.sessionId !== message.destinationSessionId)
    return yield* Effect.fail(
      new ChannelsFailure({
        operation: "native.answer",
        cause: "native reply original request is missing",
      }),
    );
  yield* requests.answer({
    inputId: message.messageId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: at,
    principal: { kind: "session", principalId: sender.id, evidenceId: message.sourceActionId },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "answer",
    allowedAction: "report_result",
    content,
    outbound: message,
  });
  return true;
  });
}

export function openNativeRequest(
  requests: GatewayRouterPorts["requests"],
  intent: LedgerAction.Receipt,
  sender: Gateway.IngestSender,
  send: Gateway.SendMessage,
  target: string,
  at: number,
  admission?: Delivery.Commit,
): Effect.Effect<void, ChannelError> {
  return Effect.gen(function* () {
  if (
    sender.kind !== "session" ||
    send.type !== "message" ||
    (send.deadline === undefined && send.to.kind !== "new_session")
  )
    return;
  yield* requests.open({
    requestId: intent.action.id,
    sessionId: sender.id,
    expectedResponders: [target],
    correlation: {},
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    deadline: send.deadline ?? Number.MAX_SAFE_INTEGER,
    at,
    ...(admission?.createSession === undefined ? {} : { admission }),
  });
  });
}
