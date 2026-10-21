import { Effect, Result } from "effect";
import { decodeChannelFailure, type ChannelError } from "../../errors";
import { canonicalDigest, Gateway, SessionTransition } from "@oni/protocol";
import type { ChannelStores } from "../stores.js";
import { matchBlacklist } from "../blacklist";
import type { GatewayRouterPorts } from "../message-ports";

/** Authenticate and normalize only. The injected kernel owns every transition. */
export function answerOwnerRequest(
  stores: ChannelStores,
  ports: GatewayRouterPorts,
  sender: Gateway.IngestSender,
  envelope: Gateway.RequestAnswer,
  receivedAt: number,
): Effect.Effect<Gateway.IngestResult, ChannelError> {
  return Effect.gen(function* () {
  if (sender.kind === "session") {
    return { status: "blocked_pre", reasonCode: "request_answer.session_sender" };
  }
  const parsed = Gateway.RequestAnswer.safeParse(envelope);
  if (!parsed.success) {
    return { status: "blocked_pre", reasonCode: "request_answer.invalid" };
  }
  if (ports.authenticateAnswer === undefined) {
    return { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" };
  }
  const { inputId, request, decision, credential } = parsed.data;
  if (canonicalDigest(request.parsedInput) !== request.inputHash) {
    return { status: "blocked_pre", reasonCode: "request_answer.rejected" };
  }
  const authenticated = yield* Effect.result(ports.authenticateAnswer(sender, credential, request.requestId).pipe(
    Effect.flatMap((value) => Effect.try({ try: () => SessionTransition.Principal.parse(value), catch: decodeChannelFailure("answer.principal") })),
  ));
  if (Result.isFailure(authenticated) || authenticated.success.kind !== "owner")
    return { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" };
  const principal = authenticated.success;
  const authenticatedAt = Math.max(receivedAt, ports.now());
  const endpoint = stores.actors.resolveEndpoint(sender.surface, sender.externalId);
  if (
    matchBlacklist(
      stores,
      {
        actorId: endpoint?.identity.id ?? principal.principalId,
        endpointId: endpoint?.endpoint.id,
        channel: sender.surface,
        candidates: [sender.surface, sender.externalId],
      },
      authenticatedAt,
    ) !== undefined
  ) {
    return { status: "blocked_pre", reasonCode: "request_answer.blacklisted" };
  }
  const resolution = yield* ports.requests.answer({
    inputId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: authenticatedAt,
    principal,
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision,
    allowedAction: "report_result",
    content: decision,
  });
  if (resolution !== "resolved" && resolution !== "refused" && resolution !== "duplicate") {
    return { status: "blocked_pre", reasonCode: `request_answer.${resolution}` };
  }
  return {
    status: "executed",
    handle: { messageId: inputId, target: request.sessionId },
    delivery: { kind: "session" },
  };
  });
}
