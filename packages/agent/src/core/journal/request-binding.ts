import { Alarm, PlainValueSchema, type LedgerAction, canonicalDigest, SessionTransition, type PlainValue } from "@openomni/protocol";

type CapturedApproval = Omit<import("../loop/executor").ExecutionApprovalRequest, "durable">;

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

import { armAction } from "../ports/alarm";

function payloadEvidence(payload: SessionTransition.Payload) {
  if (payload.kind === "request.answer") return { answer: payload.answer };
  if (payload.kind === "request.delivery") return { receipt: payload.receipt };
  return {};
}

/** Answers are the `answered` phase of the one `request` kind. */
function lifecyclePhase(
  payload: SessionTransition.Payload,
  request: SessionTransition.Request,
): "open" | "answered" | "resolved" | "expired" {
  if (payload.kind === "request.answer") return "answered";
  if (request.state === "open") return "open";
  return request.state === "expired" ? "expired" : "resolved";
}

export function inputRecord(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  inputDigest: string,
  resolution: SessionTransition.Resolution,
): LedgerAction.Append {
  const { payload } = command;
  const parentId = request.requestId;
  return {
    id: `${parentId}:input:${command.inputId}`,
    parentId,
    sessionId: command.sessionId,
    kind: "request",
    intent: {
      encodingVersion: 1,
      value: { inputId: command.inputId, inputDigest, command: payload.kind },
    },
    effect: {
      encodingVersion: 1,
      value: PlainValueSchema.parse({
        phase: lifecyclePhase(payload, request),
        request,
        resolution,
        ...payloadEvidence(payload),
      }),
    },
    ts: command.at,
    irreversible: true,
  };
}

export function resolutionRecord(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): LedgerAction.Append {
  const parentId = request.requestId;
  return {
    id: `${parentId}:resolution`,
    parentId,
    sessionId: command.sessionId,
    kind: "request",
    intent: { encodingVersion: 1, value: { phase: "resolution" } },
    effect: {
      encodingVersion: 1,
      value: PlainValueSchema.parse({
        phase: request.state === "expired" ? "expired" : "resolved",
        request,
        resolution,
      }),
    },
    ts: command.at,
    irreversible: true,
  };
}

/**
 * A `request.open` with a deadline arms `<requestId>:deadline` in the SAME batch; every terminal
 * transition retires it, and an outracing occurrence expires the request only if still open.
 */
export function deadlineArms(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  terminal: boolean,
): LedgerAction.Append[] {
  if (typeof request.deadline !== "number") return [];
  const alarmId = `${request.requestId}:deadline`;
  if (command.payload.kind === "request.open")
    return [armAction({
      parentId: null,
      sessionId: command.sessionId,
      purpose: "deadline",
      at: request.deadline,
      supersedes: null,
      alarmId,
      sourceKey: "deadline",
      payload: { requestId: request.requestId },
      armSeq: 1,
      ts: command.at,
    }).action];
  if (!terminal) return [];
  return [armAction({
    parentId: null,
    sessionId: command.sessionId,
    purpose: "deadline",
    at: null,
    supersedes: Alarm.occurrenceId(command.sessionId, alarmId, 1, "deadline"),
    alarmId,
    sourceKey: "deadline",
    payload: { requestId: request.requestId },
    armSeq: 2,
    ts: command.at,
  }).action];
}
