import { canonicalDigest, type SessionTransition, type Delivery, type PlainValue, type SessionGeneration, type PlainObject } from "@openomni/protocol";
import { Clock, Effect } from "effect";
import { AgentFailure, CommitFailed, type ExecutionError } from "../ports/failure";
import { receivedMessageAction } from "../journal/delivery";
import { requestBindingDigest } from "../journal/request-binding";
import * as SessionHandleStore from "../store/fence";
import type { SessionKernel } from "./entity";
import { type SessionRuntime, getSessionHandle, adoptSessionAuthority } from "./run";
import { Entropy } from "../ports/ports";
import { decideRequestTransition, type RequestDecision } from "./request-transition";

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

export { requestBindingDigest } from "../journal/request-binding";
export { type RequestDecision, decideRequestTransition } from "./request-transition";
