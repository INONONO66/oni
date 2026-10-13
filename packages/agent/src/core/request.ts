import { Alarm, canonicalDigest, PlainValueSchema, SessionTransition, type Delivery, type LedgerAction, type LedgerSession, type PlainValue, type SessionGeneration, type PlainObject } from "@openomni/protocol";
import { armAction } from "./alarm";
import { Clock, Effect } from "effect";
import { AgentFailure, CommitFailed, type ExecutionError } from "./failure";
import { receivedMessageAction } from "./commit";
import { requestBindingDigest } from "./request-binding";
export { requestBindingDigest } from "./request-binding";
import * as SessionHandleStore from "./store/fence";
import type { SessionKernel } from "./entity";
import { type SessionRuntime, getSessionHandle, adoptSessionAuthority } from "./run";
import { Entropy } from "./ports";
import type { ApprovalRecentOpen } from "./approval-policy";

export interface RequestDecision {
  readonly resolution: SessionTransition.Resolution;
  readonly request?: SessionTransition.Request;
  readonly actions: readonly LedgerAction.Append[];
  readonly receive?: Delivery.Commit;
  readonly requestCount?: LedgerSession.Commit["requestCount"];
}

interface RequestSnapshot {
  readonly row: LedgerSession.Row;
  readonly inputRecord?: LedgerAction.Node;
  readonly invocation?: LedgerAction.Node;
  readonly request?: SessionTransition.Request;
  readonly domainRevisions?: Readonly<Record<string, number>>;
  readonly requests?: readonly SessionTransition.Request[];
}

const rejected: RequestDecision = { resolution: "rejected", actions: [] };

function all(...checks: readonly boolean[]): boolean {
  return checks.every((check) => check);
}

/** Pure: the caller applies the whole plan under the captured lease/revision. */
export function decideRequestTransition(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  recentOpen: ApprovalRecentOpen,
): RequestDecision {
  if (
    !SessionTransition.Command.safeParse(command).success ||
    !ownsRequestRevision(command, snapshot.row)
  )
    return rejected;
  const inputDigest = requestInputDigest(command.payload);
  return (
    repeatedInput(command, snapshot, inputDigest) ??
    transition(command, snapshot, inputDigest, recentOpen)
  );
}

type ExistingPayload = Exclude<SessionTransition.Payload, { kind: "request.open" }>;

function targetRequestId(payload: ExistingPayload): string {
  if (payload.kind === "request.answer") return payload.answer.requestId;
  return payload.kind === "request.delivery" ? payload.receipt.requestId : payload.requestId;
}

function transition(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  inputDigest: string,
  recentOpen: ApprovalRecentOpen,
): RequestDecision {
  const { payload } = command;
  if (payload.kind === "request.open") {
    return openRequest(command, snapshot, payload.request, inputDigest, recentOpen);
  }
  const request = snapshot.request;
  if (request === undefined || !targets(request, payload, snapshot.row.id)) return rejected;
  return transitionExisting(command, snapshot, request, payload, inputDigest);
}

function targets(
  request: SessionTransition.Request,
  payload: ExistingPayload,
  sessionId: string,
): boolean {
  return request.requestId === targetRequestId(payload) && request.sessionId === sessionId;
}

function transitionExisting(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  request: SessionTransition.Request,
  payload: ExistingPayload,
  inputDigest: string,
): RequestDecision {
  switch (payload.kind) {
    case "request.delivery": return recordDelivery(command, request, payload.receipt, inputDigest);
    case "request.answer": return answerRequest(command, snapshot, request, payload.answer, inputDigest);
    case "request.timeout":
    case "request.cancel": return closeRequest(command, request, payload, inputDigest);
  }
}

function ownsRequestRevision(command: SessionTransition.Command, row: LedgerSession.Row): boolean {
  return all(
    row.id === command.sessionId,
    row.fenceOwner === command.authority.owner,
    row.fence === command.authority.fence,
    row.revision === command.expectedRevision,
  );
}

function recordedResolution(action: LedgerAction.Node): SessionTransition.Resolution | undefined {
  const resolution = SessionTransition.Resolution.safeParse(
    objectValue(action.effect.value)?.resolution,
  );
  return resolution.success ? resolution.data : undefined;
}

function replayedInput(
  action: LedgerAction.Node,
  request: SessionTransition.Request | undefined,
  inputDigest: string,
): RequestDecision {
  if (objectValue(action.intent.value)?.inputDigest !== inputDigest) return rejected;
  const resolution = recordedResolution(action);
  return resolution === undefined ? rejected : { resolution, request, actions: [] };
}

function repeatedInput(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  inputDigest: string,
): RequestDecision | undefined {
  const previous = snapshot.inputRecord;
  if (previous === undefined) return undefined;
  const requestId = command.payload.kind === "request.open"
    ? command.payload.request.requestId : targetRequestId(command.payload);
  if (!all(
    previous.sessionId === command.sessionId,
    previous.parentId === requestId,
    previous.id === `${requestId}:input:${command.inputId}`,
    objectValue(previous.intent.value)?.inputId === command.inputId,
  )) return rejected;
  return replayedInput(previous, snapshot.request, inputDigest);
}

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

function inputRecord(
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

function resolutionRecord(
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
function deadlineArms(
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

function recordRequest(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  inputDigest: string,
  resolution: SessionTransition.Resolution,
  terminal = false,
): RequestDecision {
  const writes: LedgerAction.Append[] = [inputRecord(command, request, inputDigest, resolution)];
  if (terminal) writes.push(resolutionRecord(command, request, resolution));
  writes.push(...deadlineArms(command, request, terminal));
  const receive = receivingIntake(command, request, resolution);
  return { resolution, request, actions: writes, ...(receive === undefined ? {} : { receive }) };
}

function receivesReply(
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): boolean {
  return request.mode === "answer" && (resolution === "attached" || resolution === "resolved");
}

function replyIntake(
  at: number,
  request: SessionTransition.Request,
  answer: SessionTransition.Answer,
): Delivery.Commit {
  return {
    id: answer.inputId,
    sessionId: request.sessionId,
    kind: "prompt",
    content: answer.content,
    createdAt: at,
    parentActionId: request.requestId,
    origin: {
      encodingVersion: 1,
      value: PlainValueSchema.parse(
        answer.outbound ?? {
          kind: "external_reply",
          messageId: answer.inputId,
          sourceActionId: request.requestId,
          replyTo: request.requestId,
        },
      ),
    },
  };
}

function receivingIntake(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): Delivery.Commit | undefined {
  const { payload } = command;
  if (payload.kind !== "request.answer" || !receivesReply(request, resolution)) return undefined;
  return replyIntake(command.at, request, payload.answer);
}

type ApprovalCount = NonNullable<LedgerSession.Commit["requestCount"]>;

function openApprovalSince(existing: SessionTransition.Request, since: number): boolean {
  return existing.mode === "approval" && existing.state === "open" && existing.createdAt > since;
}

function openApprovalCount(
  snapshot: RequestSnapshot,
  next: SessionTransition.Request,
  since: number,
): ApprovalCount | undefined {
  if (next.mode !== "approval") return undefined;
  const open = (snapshot.requests ?? []).filter((existing) => openApprovalSince(existing, since));
  return { since, count: open.length };
}

function exceedsApprovalBudget(
  requestCount: ApprovalCount | undefined,
  limit: number,
): boolean {
  return requestCount !== undefined && requestCount.count >= limit;
}

function freshRequestShape(next: SessionTransition.Request): boolean {
  return all(
    next.state === "open",
    next.outcome === null,
    next.seenReplyIds.length === 0,
    next.replies.length === 0,
  );
}

function admitsOpen(next: SessionTransition.Request, snapshot: RequestSnapshot): boolean {
  return all(
    snapshot.request === undefined,
    originalInvocationMatches(next, snapshot),
    next.sessionId === snapshot.row.id,
    freshRequestShape(next),
    generationMatches(next, snapshot.row),
    next.bindingDigest === requestBindingDigest(next),
  );
}

function openRequest(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  next: SessionTransition.Request,
  inputDigest: string,
  recentOpen: ApprovalRecentOpen,
): RequestDecision {
  const requestCount = openApprovalCount(snapshot, next, command.at - recentOpen.windowMs);
  if (exceedsApprovalBudget(requestCount, recentOpen.limit) || !admitsOpen(next, snapshot)) return rejected;
  return {
    ...recordRequest(command, next, inputDigest, "opened"),
    ...(requestCount === undefined ? {} : { requestCount }),
  };
}

function intentInvocation(invocation: ReturnType<typeof objectValue>) {
  return invocation?.phase === "intent" ? invocation : undefined;
}

function recordedInvocation(original: LedgerAction.Node | undefined, sessionId: string) {
  if (original?.sessionId !== sessionId) return undefined;
  return intentInvocation(objectValue(original.intent.value));
}

function domainRevisionsAgree(
  recorded: PlainValue | undefined,
  expected: Readonly<Record<string, number>>,
): boolean {
  return recorded === undefined || canonicalDigest(recorded) === canonicalDigest(expected);
}

function originalInvocationMatches(
  next: SessionTransition.Request,
  snapshot: RequestSnapshot,
): boolean {
  const invocation = recordedInvocation(snapshot.invocation, snapshot.row.id);
  if (invocation === undefined || invocation.value === undefined) return false;
  return all(
    snapshot.invocation?.id === next.requestId,
    canonicalDigest(invocation.originalArgs ?? invocation.value) === next.inputHash,
    canonicalDigest(next.parsedInput) === next.inputHash,
    invocation.effectHash === next.effectHash,
    domainRevisionsAgree(invocation.domainRevisions, next.domainRevisions),
  );
}

function generationMatches(request: SessionTransition.Request, row: LedgerSession.Row): boolean {
  return all(
    request.generation === row.policyGeneration,
    request.toolsGeneration === row.toolsGeneration,
    request.systemHash === row.systemHash,
  );
}

function recordDelivery(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  receipt: SessionTransition.DeliveryReceipt,
  inputDigest: string,
): RequestDecision {
  let request = current;
  if (!all(
    receipt.sessionId === command.sessionId,
    receipt.sourceActionId === request.requestId,
    receipt.inputId === command.inputId,
  )) return rejected;
  if (receipt.externalMessageId !== undefined) {
    request = {
      ...request,
      correlation: { ...request.correlation, replyToMessageId: receipt.externalMessageId },
    };
    request.bindingDigest = requestBindingDigest(request);
  }
  return recordRequest(command, request, inputDigest, "delivery_recorded");
}

function answerAddressed(
  answer: SessionTransition.Answer,
  command: SessionTransition.Command,
): boolean {
  return answer.sessionId === command.sessionId && answer.inputId === command.inputId;
}

function lateAnswer(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  const terminal = current.state === "open";
  const seen = withSeenReply(current, answer.inputId);
  const request: SessionTransition.Request = terminal
    ? { ...seen, state: "expired", outcome: "outcome_unknown" }
    : seen;
  return recordRequest(command, request, inputDigest, "late_unknown", terminal);
}

function replyOf(answer: SessionTransition.Answer): SessionTransition.Request["replies"][number] {
  return {
    replyId: answer.inputId,
    responderId: answer.principal.principalId,
    content: answer.content,
    receivedAt: answer.receivedAt,
  };
}

function settleReply(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  if (answer.decision === "refuse") {
    const refused: SessionTransition.Request = { ...request, state: "refused", outcome: "denied" };
    return recordRequest(command, refused, inputDigest, "refused", true);
  }
  if (request.replies.length >= request.threshold) {
    const resolved: SessionTransition.Request = {
      ...request,
      state: "resolved",
      outcome: "answered",
    };
    return recordRequest(command, resolved, inputDigest, "resolved", true);
  }
  return recordRequest(command, request, inputDigest, "attached");
}

function attachAnswer(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  const previouslySeen = current.seenReplyIds.includes(answer.inputId);
  const seen = withSeenReply(current, answer.inputId);
  if (
    seen.state !== "open" ||
    previouslySeen ||
    seen.replies.some((reply) => reply.responderId === answer.principal.principalId)
  )
    return recordRequest(command, seen, inputDigest, "duplicate");
  const replied = { ...seen, replies: [...seen.replies, replyOf(answer)] };
  return settleReply(command, replied, answer, inputDigest);
}

function answerRequest(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  if (!answerAddressed(answer, command)) return rejected;
  if (Math.max(command.at, answer.receivedAt) >= current.deadline)
    return lateAnswer(command, current, answer, inputDigest);
  if (!answerBindingMatches(answer, current, snapshot))
    return recordRequest(command, current, inputDigest, "rejected");
  return attachAnswer(command, current, answer, inputDigest);
}

function withSeenReply(
  request: SessionTransition.Request,
  inputId: string,
): SessionTransition.Request {
  return { ...request, seenReplyIds: [...new Set([...request.seenReplyIds, inputId])] };
}

function principalValid(
  answer: SessionTransition.Answer,
  request: SessionTransition.Request,
): boolean {
  if (request.mode === "approval")
    return answer.principal.kind === "owner" && answer.decision !== "answer";
  return answer.decision !== "approve";
}

function answerBindingMatches(
  answer: SessionTransition.Answer,
  request: SessionTransition.Request,
  snapshot: RequestSnapshot,
): boolean {
  return all(
    principalValid(answer, request),
    request.expectedResponders.includes(answer.principal.principalId),
    answer.bindingDigest === request.bindingDigest,
    answer.inputHash === request.inputHash,
    answer.effectHash === request.effectHash,
    answer.generation === request.generation,
    answer.toolsHash === request.toolsHash,
    request.allowedActions.includes(answer.allowedAction),
    canonicalDigest(answer.domainRevisions) === canonicalDigest(request.domainRevisions),
    domainRevisionsMatch(request, snapshot.domainRevisions),
    generationMatches(request, snapshot.row),
  );
}

function domainRevisionsMatch(
  request: SessionTransition.Request,
  current: Readonly<Record<string, number>> | undefined,
): boolean {
  if (current === undefined) return Object.keys(request.domainRevisions).length === 0;
  return canonicalDigest({ ...current }) === canonicalDigest(request.domainRevisions);
}

function expireRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  inputDigest: string,
): RequestDecision {
  if (command.at < current.deadline) return rejected;
  const expired: SessionTransition.Request = {
    ...current,
    state: "expired",
    outcome: "outcome_unknown",
  };
  return recordRequest(command, expired, inputDigest, "expired", true);
}

function mayCancel(principal: SessionTransition.Principal, sessionId: string): boolean {
  return (
    principal.kind === "owner" ||
    (principal.kind === "session" && principal.principalId === sessionId)
  );
}

function cancelRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  principal: SessionTransition.Principal,
  inputDigest: string,
): RequestDecision {
  if (!mayCancel(principal, command.sessionId))
    return recordRequest(command, current, inputDigest, "rejected");
  const cancelled: SessionTransition.Request = {
    ...current,
    state: "cancelled",
    outcome: "cancelled",
  };
  return recordRequest(command, cancelled, inputDigest, "cancelled", true);
}

function closeRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  payload: Extract<SessionTransition.Payload, { kind: "request.timeout" | "request.cancel" }>,
  inputDigest: string,
): RequestDecision {
  if (current.state !== "open") return recordRequest(command, current, inputDigest, "duplicate");
  switch (payload.kind) {
    case "request.timeout": return expireRequest(command, current, inputDigest);
    case "request.cancel": return cancelRequest(command, current, payload.principal, inputDigest);
  }
}

function requestInputDigest(payload: SessionTransition.Payload): string {
  if (payload.kind === "request.answer") {
    const { receivedAt: _receivedAt, ...answer } = payload.answer;
    return canonicalDigest(PlainValueSchema.parse({ kind: payload.kind, answer }));
  }
  if (payload.kind === "request.delivery") {
    const { at: _at, ...receipt } = payload.receipt;
    return canonicalDigest(PlainValueSchema.parse({ kind: payload.kind, receipt }));
  }
  return canonicalDigest(PlainValueSchema.parse(payload));
}

function objectValue(value: PlainValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export interface SessionRequestPort {
  list(): readonly SessionTransition.Request[];
  timeout(requestId: string, at: number): Effect.Effect<void, ExecutionError>;
  cancel(input: {
    requestId: string;
    sessionId: string;
    inputId: string;
    principal: SessionTransition.Principal;
    at: number;
  }): Effect.Effect<SessionTransition.Resolution, ExecutionError>;
  open(input: {
    requestId: string;
    sessionId: string;
    expectedResponders: readonly string[];
    correlation: SessionTransition.Correlation;
    allowedActions: readonly SessionTransition.AllowedAction[];
    resolution: "first" | "quorum" | "all";
    threshold: number;
    deadline: number;
    at: number;
    admission?: Delivery.Commit;
  }): Effect.Effect<SessionTransition.Request, ExecutionError>;
  answer(input: SessionTransition.Answer): Effect.Effect<SessionTransition.Resolution, ExecutionError>;
  receipt(input: SessionTransition.DeliveryReceipt): Effect.Effect<SessionTransition.Request, ExecutionError>;
}

function requestGeneration(
  kernel: SessionKernel,
  sessionId: string,
  turnId: string | null,
): SessionGeneration.Snapshot | undefined {
  if (turnId === null) return kernel.latestGenerationFor(sessionId);
  const turn = SessionHandleStore.turnIntent(kernel.actionById(turnId));
  const generation =
    turn === undefined
      ? undefined
      : kernel.generationFor(sessionId, turn.toolsGeneration);
  if (
    turn === undefined ||
    generation === undefined ||
    generation.toolsHash !== turn.toolsHash ||
    generation.systemHash !== turn.systemHash ||
    generation.policyGeneration !== turn.policyGeneration
  )
    return undefined;
  return generation;
}

/** The gateway gets this injected port, never a lifecycle store. */
/** Anything else is an invariant break, not a session failure. */
function originalInvocation(kernel: SessionKernel, requestId: string): (PlainObject & { readonly value: PlainValue }) | undefined {
  const intent = kernel.actionById(requestId)?.intent.value;
  if (intent === null || intent === undefined || typeof intent !== "object" || Array.isArray(intent) || intent.value === undefined)
    return undefined;
  return { ...intent, value: intent.value };
}

function openedRequest(
  input: Parameters<SessionRequestPort["open"]>[0],
  intent: PlainObject & { readonly value: PlainValue },
  turnId: string | null,
  generation: SessionGeneration.Snapshot,
): SessionTransition.Request {
  const value: PlainValue = intent.originalArgs ?? intent.value;
  const request: SessionTransition.Request = {
    requestId: input.requestId,
    sessionId: input.sessionId,
    turnId,
    callId: typeof intent.callId === "string" ? intent.callId : input.requestId,
    mode: "answer",
    parsedInput: value,
    inputHash: canonicalDigest(value),
    effectHash: typeof intent.effectHash === "string" ? intent.effectHash : canonicalDigest({}),
    generation: generation.policyGeneration,
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    domainRevisions: {},
    deadline: input.deadline,
    expectedResponders: [...input.expectedResponders],
    correlation: input.correlation,
    allowedActions: [...input.allowedActions],
    bindingDigest: "",
    resolution: input.resolution,
    threshold: input.threshold,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: input.at,
  };
  request.bindingDigest = requestBindingDigest(request);
  return request;
}

export function createSessionRequests(runtime: SessionRuntime): Effect.Effect<SessionRequestPort, never, Entropy> {
  return Effect.gen(function* () {
  const clock = yield* Clock.clockWith(Effect.succeed).pipe(Effect.map((service) => () => service.currentTimeMillisUnsafe()));
  const { id } = yield* Entropy;
  function transition(
    sessionId: string,
    payload: SessionTransition.Payload,
    inputId: string,
    at: number,
    admission?: Delivery.Commit,
  ) {
    return Effect.gen(function* () {
    const live = getSessionHandle(sessionId, runtime);
    if (live !== undefined) return yield* live.requests.transition(payload, inputId, at, admission);
    // Out-of-turn authority is a fence adoption: this writer becomes the current
    // activation for exactly this commit; a live activation elsewhere goes stale.
    const owner = `${runtime.processId ?? process.pid}:request:${id()}`;
    const kernel = runtime.openKernel(sessionId);
    const now = clock();
    const fence = yield* adoptSessionAuthority(kernel, sessionId, owner).pipe(
      Effect.mapError((error) => new CommitFailed({ error })),
    );
    return yield* commitSessionRequest(
      kernel, sessionId, { owner, fence }, payload, inputId, Math.max(at, now), runtime, admission,
    );
    });
  }
  function timeout(requestId: string, at: number): Effect.Effect<void, ExecutionError> {
    return Effect.gen(function* () {
    const request = findRequest(requestId);
    if (request === undefined)
      return yield* Effect.die(new Error(`deadline request missing: ${requestId}`));
    const result = yield* transition(
      request.sessionId,
      { kind: "request.timeout", requestId },
      `${requestId}:deadline`,
      at,
    );
    if (
      result.actions.length > 0 &&
      result.request?.mode === "approval" &&
      result.request.state !== "open"
    )
      runtime.onRequestReady?.(request.sessionId);
    });
  }
  function findRequest(requestId: string): SessionTransition.Request | undefined {
    for (const row of runtime.listSessions()) {
      const request = runtime.openKernel(row.id).requestById(requestId);
      if (request !== undefined) return request;
    }
    return undefined;
  }
  return {
    list: () => runtime.listSessions().flatMap((row) => runtime.openKernel(row.id).requestRows(row.id)),
    timeout,
    cancel(input) {
      return Effect.gen(function* () {
        const result = yield* transition(
          input.sessionId,
          { kind: "request.cancel", requestId: input.requestId, principal: input.principal },
          input.inputId,
          input.at,
        );
        if (result.actions.length > 0 && result.request?.mode === "approval" && result.request.state !== "open")
          runtime.onRequestReady?.(input.sessionId);
        return result.resolution;
      });
    },
    open(input) {
      return Effect.gen(function* () {
      const kernel = runtime.openKernel(input.sessionId);
      const intent = originalInvocation(kernel, input.requestId);
      if (intent === undefined)
        return yield* Effect.die(new Error(`original invocation missing: ${input.requestId}`));
      const turnId = typeof intent.turnId === "string" ? intent.turnId : null;
      const generation = requestGeneration(kernel, input.sessionId, turnId);
      if (generation === undefined)
        return yield* new AgentFailure({ operation: "request.open", cause: "original_generation_unavailable" });
      const request = openedRequest(input, intent, turnId, generation);
      const decision = yield* transition(
        input.sessionId,
        { kind: "request.open", request },
        `${input.requestId}:open`,
        input.at,
        input.admission,
      );
      if (decision.request === undefined)
        return yield* new AgentFailure({ operation: "request.open", cause: `refused:${input.requestId}` });
      return decision.request;
      });
    },
    answer(answer) {
      return Effect.gen(function* () {
      const result = yield* transition(
        answer.sessionId,
        { kind: "request.answer", answer },
        answer.inputId,
        clock(),
      );
      if (result.receive !== undefined) runtime.onDeliveryCommitted?.([result.receive.sessionId]);
      if (
        result.actions.length > 0 &&
        result.request?.mode === "approval" &&
        result.request.state !== "open"
      )
        runtime.onRequestReady?.(answer.sessionId);
      return result.resolution;
      });
    },
    receipt(receipt) {
      return Effect.gen(function* () {
      const result = yield* transition(
        receipt.sessionId,
        { kind: "request.delivery", receipt },
        receipt.inputId,
        clock(),
      );
      if (result.request === undefined)
        return yield* new AgentFailure({ operation: "request.receipt", cause: `refused:${receipt.requestId}` });
      return result.request;
      });
    },
  } satisfies SessionRequestPort;
  });
}

function requestIdentity(payload: SessionTransition.Payload): string {
  switch (payload.kind) {
    case "request.open": return payload.request.requestId;
    case "request.answer": return payload.answer.requestId;
    case "request.delivery": return payload.receipt.requestId;
    case "request.timeout":
    case "request.cancel": return payload.requestId;
  }
}

export function commitSessionRequest(
  kernel: SessionKernel,
  sessionId: string,
  authority: { owner: string; fence: number },
  payload: SessionTransition.Payload,
  inputId: string,
  at: number,
  runtime: SessionRuntime,
  admission?: Delivery.Commit,
): Effect.Effect<RequestDecision, ExecutionError> {
  return Effect.gen(function* () {
    const row = kernel.row(sessionId);
    const requestId = requestIdentity(payload);
    const request = kernel.requestById(requestId);
    const decision = decideRequestTransition({ version: 1, sessionId, inputId, at, expectedRevision: row.revision, authority, payload }, {
      row,
      inputRecord: kernel.requestInputById(sessionId, inputId),
      invocation: kernel.actionById(requestId),
      request,
      requests: kernel.requestRows(),
      domainRevisions: request === undefined ? undefined : runtime.requestDomainRevisions?.(request),
    }, runtime.approvalPolicy.recentOpen);
    if (decision.actions.length > 0) {
      // A foreign-session admission (a `new_session` child's message) never rides
      // this single-session fenced batch: the child's own entity commits it.
      const intake = [
        ...(decision.receive === undefined ? [] : [decision.receive]),
        ...(admission === undefined || admission.sessionId !== sessionId ? [] : [admission]),
      ].map((commit) => receivedMessageAction({ ...commit, at: commit.createdAt }));
      yield* kernel.commit({
        sessionId,
        ...authority,
        now: at,
        expectedRevision: row.revision,
        actions: [...decision.actions, ...intake],
        state: row.state,
        ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
    }
    return decision;
  });
}

/**
 * Adopting a fresh fence while an entity turn runs would steal its authority
 * and kill its wave, so this view BORROWS the live owner+fence for the one
 * caller that adopted through it; fence and revision are never masked.
 */
export function requestAuthorityKernel(base: SessionKernel, sessionId: string): SessionKernel {
  const holder: {
    borrowed: { readonly owner: string; readonly fence: number } | undefined;
    caller: string | undefined;
  } = { borrowed: undefined, caller: undefined };
  return {
    ...base,
    row: (id: string) => {
      const row = base.row(id);
      return holder.borrowed !== undefined && holder.caller !== undefined && id === sessionId
        ? { ...row, fenceOwner: holder.caller }
        : row;
    },
    adoptFence: (input) =>
      Effect.suspend(() => {
        const row = base.row(sessionId);
        if (input.sessionId === sessionId && row.state === "running" && row.fenceOwner !== null) {
          holder.borrowed = { owner: row.fenceOwner, fence: row.fence };
          holder.caller = input.owner;
          return Effect.succeed({ ok: true as const, fence: row.fence });
        }
        return base.adoptFence(input);
      }),
    commit: (input) =>
      base.commit(
        holder.borrowed === undefined
          ? input
          : { ...input, owner: holder.borrowed.owner, fence: holder.borrowed.fence },
      ),
  };
}
