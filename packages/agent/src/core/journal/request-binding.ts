import { canonicalDigest, SessionTransition, type PlainValue } from "@openomni/protocol";

type CapturedApproval = Omit<import("./gate/decide").ExecutionApprovalRequest, "durable">;

function generationDefaults(captured: CapturedApproval) {
  return {
    toolsGeneration: captured.toolsGeneration ?? 0,
    toolsHash: captured.toolsHash ?? canonicalDigest([]),
  };
}

export function createApprovalRequest(
  captured: CapturedApproval,
  binding: {
    readonly effect: PlainValue;
    readonly domainRevisions?: Readonly<Record<string, number>>;
  },
  systemHash: string | undefined,
  createdAt: number,
  timeout: number,
  responders: readonly string[],
): SessionTransition.Request {
  const request = SessionTransition.Request.parse({
    requestId: captured.id,
    sessionId: captured.sessionId,
    turnId: captured.turnId,
    callId: captured.callId,
    mode: "approval",
    parsedInput: captured.intent,
    inputHash: captured.inputHash,
    effectHash: canonicalDigest(binding.effect),
    generation: captured.generation,
    ...generationDefaults(captured),
    systemHash: systemHash ?? canonicalDigest([]),
    domainRevisions: binding.domainRevisions ?? {},
    deadline: createdAt + timeout,
    expectedResponders: [...responders],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "pending",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt,
  });
  return { ...request, bindingDigest: requestBindingDigest(request) };
}

export function requestBindingDigest(request: SessionTransition.Request): string {
  return canonicalDigest({
    requestId: request.requestId,
    sessionId: request.sessionId,
    callId: request.callId,
    mode: request.mode,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsGeneration: request.toolsGeneration,
    toolsHash: request.toolsHash,
    systemHash: request.systemHash,
    domainRevisions: request.domainRevisions,
    deadline: request.deadline,
    expectedResponders: request.expectedResponders,
    correlation: request.correlation,
    allowedActions: request.allowedActions,
    resolution: request.resolution,
    threshold: request.threshold,
  });
}
