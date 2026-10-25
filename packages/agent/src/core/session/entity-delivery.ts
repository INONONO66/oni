import { storedActionRow } from "../store/action-row";
import { CommitRefused, FenceRefused, type LedgerError } from "../store/errors";
import { parsePlainJson } from "../store/storage/sqlite-l0-rows";
import { Delivery, SessionTransition, type LedgerAction } from "@oni/protocol";
import { Cause, Deferred, Effect, Exit, Option, Schema, type Scope } from "effect";
import { LeaseLost, SessionAdmissionRefused, type SessionError } from "../ports/failure";
import { createSessionAdmission, decideSessionAdmission } from "./admission";
import { createSessionRecovery } from "./recovery";
import { type SessionAdmissionSnapshot, type SessionEntityAuthority, type SessionEntityPorts, type SessionControllerState, type ResolvedSessionRuntime, type SessionRunner, type SessionRunnerResult, createSessionTurn } from "./run";
import { deliveryActions, receivedMessageAction } from "../journal/delivery";
import { createRawSlots } from "../loop/executor";
import { decideRequestTransition } from "./request";
import { AdmissionFailure, DeliverBody, type DeliverReceipt, DeliverRefused, ResolveRefused } from "../journal/messages";
import { commitIn, retryRevision, type ActivationHandle, type SessionKernel } from "./entity-activation";

interface ReceivedEnvelope {
  readonly messageId: string;
  readonly content: string;
  readonly origin: string;
}

function receivedActionFor(
  sessionId: string,
  kind: Delivery.Kind,
  message: ReceivedEnvelope,
  at: number,
  delivery?: "steer" | "followUp",
  after?: number,
): LedgerAction.Append {
  const source = parsePlainJson(message.origin);
  const origin =
    after === undefined || source === null || typeof source !== "object" || Array.isArray(source)
      ? source
      : { ...source, after };
  return receivedMessageAction({
    id: message.messageId,
    sessionId,
    kind,
    content: message.content,
    origin: { encodingVersion: 1, value: origin },
    parentActionId: null,
    at,
    ...(delivery === undefined ? {} : { delivery }),
  });
}

function replayedReceived(
  handle: ActivationHandle,
  kind: Delivery.Kind,
  message: ReceivedEnvelope,
  delivery?: "steer" | "followUp",
  after?: number,
): Effect.Effect<{ readonly ordinal: number } | undefined, DeliverRefused> {
  return Effect.suspend(() => {
    const existing = handle.kernel.actionById(message.messageId);
    if (existing === undefined) return Effect.succeed(undefined);
    const candidate = receivedActionFor(
      handle.authority.sessionId, kind, message, existing.ts, delivery, after,
    );
    const replay = JSON.stringify(storedActionRow(candidate, existing.ordinal));
    const stored = JSON.stringify(storedActionRow(existing, existing.ordinal));
    return replay === stored
      ? Effect.succeed({ ordinal: existing.ordinal })
      : Effect.fail(new DeliverRefused({ code: "idempotency_conflict" }));
  });
}

export function appendReceived(
  handle: ActivationHandle,
  kind: Delivery.Kind,
  message: ReceivedEnvelope,
  delivery?: "steer" | "followUp",
  after?: number,
): Effect.Effect<{ readonly ordinal: number; readonly deduped: boolean }, LedgerError | AdmissionFailure | DeliverRefused> {
  return retryRevision(() => Effect.gen(function* () {
    const { kernel, authority, env } = handle;
    const replayed = yield* replayedReceived(handle, kind, message, delivery, after);
    if (replayed !== undefined) return { ...replayed, deduped: true };
    const row = kernel.row(authority.sessionId);
    const now = env.clock();
    const action = receivedActionFor(authority.sessionId, kind, message, now, delivery, after);
    const committed = yield* commitIn(handle, {
      sessionId: authority.sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now,
      expectedRevision: row.revision,
      actions: [action],
      state: kind === "interrupt" && row.state === "running" ? "interrupted" : row.state,
    });
    const receipt = committed.receipts[0];
    if (receipt === undefined)
      return yield* Effect.die(new Error(`commit returned no receipt: ${message.messageId}`));
    return { ordinal: receipt.action.ordinal, deduped: false };
  }));
}

function admissionSnapshot(handle: ActivationHandle): SessionAdmissionSnapshot {
  const { kernel, authority, env } = handle;
  const row = kernel.row(authority.sessionId);
  const pending = kernel.pendingMessages(authority.sessionId);
  const open = kernel.latestOpenTurn(authority.sessionId);
  const terminal = kernel.latestTurnTerminal(authority.sessionId);
  return {
    row, pending,
    ...(open === undefined ? {} : { open }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(env.ports.capabilityKinds === undefined ? {} : { capabilityKinds: env.ports.capabilityKinds }),
  };
}

function consumePending(handle: ActivationHandle, items: readonly Delivery.Row[]): Effect.Effect<void, LedgerError> {
  const { kernel, authority, env } = handle;
  const row = kernel.row(authority.sessionId);
  const parentId = kernel.latestAction(authority.sessionId)?.id ?? null;
  return commitIn(handle, {
    sessionId: authority.sessionId,
    owner: authority.owner,
    fence: authority.fence,
    now: env.clock(),
    expectedRevision: row.revision,
    actions: deliveryActions(items, { kind: "pending" }, "before_llm", parentId),
    state: row.state,
  }).pipe(Effect.asVoid);
}

function detachTurn(handle: ActivationHandle, body: Effect.Effect<void, SessionError>): Effect.Effect<void, SessionError> {
  return Effect.gen(function* () {
    const token = yield* Deferred.make<void>();
    handle.live.current = token;
    yield* handle.keepAlive(true);
    yield* Effect.forkIn(
      body.pipe(
        Effect.ensuring(Effect.suspend(() => {
          if (handle.live.current !== token) return Effect.void;
          handle.live.current = undefined;
          return Deferred.succeed(token, undefined).pipe(Effect.andThen(handle.keepAlive(false)));
        })),
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError(`detached session turn failed: ${handle.authority.sessionId}`, cause),
        ),
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit)) {
            if (Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
            if (
              error instanceof LeaseLost ||
              (error instanceof FenceRefused && error.reason === "stale") ||
              (error instanceof CommitRefused && error.reason === "fence")
            ) return Effect.void;
          }
          return Effect.suspend(() => drain(handle));
        }),
        Effect.orDie,
      ),
      handle.scope,
    );
  });
}

export type SessionDrainOutcome =
  | { readonly kind: "stop" }
  | { readonly kind: "refused"; readonly refusal: SessionAdmissionRefused }
  | { readonly kind: "turn" };

export function drain(handle: ActivationHandle): Effect.Effect<SessionDrainOutcome, LedgerError | SessionError> {
  const { authority, kernel, env } = handle;
  const detach = (body: Effect.Effect<void, SessionError>) => detachTurn(handle, body);
  return handle.gate.withPermits(1)(Effect.gen(function* () {
    let ranTurn = false;
    for (;;) {
      if (handle.live.current !== undefined) return { kind: "turn" as const };
      const snapshot = admissionSnapshot(handle);
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
          return ranTurn ? { kind: "turn" as const } : { kind: "stop" as const };
        case "refused": {
          const refusal = new SessionAdmissionRefused(authority.sessionId);
          yield* Effect.logWarning(refusal.message);
          return { kind: "refused" as const, refusal };
        }
        case "consume":
          yield* consumePending(handle, decision.items);
          continue;
        case "start":
          yield* env.ports.runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach });
          ranTurn = true;
          continue;
        default:
          yield* env.ports.runTurn({ authority, kernel, decision, snapshot, detach });
          ranTurn = true;
          continue;
      }
    }
  }));
}

const decodeDeliverBody = Schema.decodeUnknownSync(DeliverBody);

function deliverCandidate(
  handle: ActivationHandle,
  payload: { readonly source: string; readonly idempotencyKey: string },
  body: DeliverBody,
  deliveryKind: Delivery.Kind,
): Delivery.Row {
  const { kernel, authority, env } = handle;
  return Delivery.Row.parse({
    id: payload.idempotencyKey,
    sessionId: authority.sessionId,
    kind: deliveryKind,
    content: body.content,
    origin: { encodingVersion: 1, value: parsePlainJson(payload.source) },
    ...(body.delivery === undefined ? {} : { delivery: body.delivery }),
    ...(body.after === undefined ? {} : { after: body.after }),
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: env.clock(),
    ordinal: kernel.pendingMessages(authority.sessionId).length + 1,
  });
}

export function deliver(
  handle: ActivationHandle,
  payload: {
    readonly kind: string;
    readonly body: string;
    readonly source: string;
    readonly idempotencyKey: string;
  },
): Effect.Effect<DeliverReceipt, DeliverRefused | AdmissionFailure> {
  const { kernel, authority, env } = handle;
  return Effect.gen(function* () {
    if (payload.idempotencyKey.trim().length === 0)
      return yield* new DeliverRefused({ code: "missing_key" });
    const registered = env.ports.inputRegistrations;
    if (registered === undefined) return yield* new DeliverRefused({ code: "seam_missing" });
    if (!registered.includes(payload.kind))
      return yield* new DeliverRefused({ code: "unknown_kind" });
    const row = kernel.row(authority.sessionId);
    const malformed = () => new DeliverRefused({ code: "malformed_body" });
    const body = yield* Effect.try({
      try: () => {
        parsePlainJson(payload.source);
        return decodeDeliverBody(parsePlainJson(payload.body));
      },
      catch: malformed,
    });
    const deliveryKind: Delivery.Kind =
      payload.kind === "prompt"
        ? "prompt"
        : payload.kind === "action"
          ? "action"
          : (body.control ?? (yield* malformed()));
    const replayed = yield* replayedReceived(
      handle,
      deliveryKind,
      { messageId: payload.idempotencyKey, content: body.content, origin: payload.source },
      body.delivery,
      body.after,
    );
    if (replayed !== undefined) return { seq: replayed.ordinal, existed: true };
    const candidate = deliverCandidate(handle, payload, body, deliveryKind);
    const snapshot = admissionSnapshot(handle);
    const decision = decideSessionAdmission({
      ...snapshot,
      pending: [...snapshot.pending, candidate],
      row,
    });
    if (decision.kind === "refused")
      return yield* new DeliverRefused({
        code: decision.reason === "unknown_kind" ? "unknown_kind" : "denied",
      });
    const receipt = yield* appendReceived(
      handle,
      deliveryKind,
      {
        messageId: payload.idempotencyKey,
        content: body.content,
        origin: payload.source,
      },
      body.delivery,
      body.after,
    ).pipe(Effect.catchIf(
      (error): error is LedgerError =>
        !(error instanceof AdmissionFailure) && !(error instanceof DeliverRefused),
      (error) => Effect.die(error),
    ));
    yield* drain(handle).pipe(Effect.orDie);
    return { seq: receipt.ordinal, existed: receipt.deduped };
  });
}

export function resolveCommand(
  handle: ActivationHandle,
  payload: {
    readonly requestId: string;
    readonly outcome: "resolved" | "cancelled";
    readonly payload: string;
    readonly inputId: string;
  },
): Effect.Effect<{ readonly resolution: string }, ResolveRefused | AdmissionFailure> {
  const { kernel, authority } = handle;
  return Effect.gen(function* () {
    const replayed = kernel.requestInputById(authority.sessionId, payload.inputId) !== undefined;
    if (!replayed) {
      const request = kernel.requestById(payload.requestId);
      if (request === undefined) return yield* new ResolveRefused({ code: "unknown_request" });
      if (request.state !== "open") return yield* new ResolveRefused({ code: "already_resolved" });
    }
    const transition = yield* Effect.try({
      try: (): SessionTransition.Payload =>
        payload.outcome === "resolved"
          ? SessionTransition.Payload.parse(parsePlainJson(payload.payload))
          : {
              kind: "request.cancel",
              requestId: payload.requestId,
              principal: SessionTransition.Principal.parse(parsePlainJson(payload.payload)),
            },
      catch: () => new ResolveRefused({ code: "malformed_body" }),
    });
    return yield* requestCommand(handle, payload.requestId, payload.inputId, transition);
  });
}

function requestSnapshot(
  handle: ActivationHandle,
  requestId: string,
  inputId: string,
  row: ReturnType<SessionKernel["row"]>,
): Parameters<typeof decideRequestTransition>[1] {
  const { kernel, authority, env } = handle;
  const request = kernel.requestById(requestId);
  const inputRecord = kernel.requestInputById(authority.sessionId, inputId);
  const invocation = kernel.actionById(requestId);
  return {
    row,
    ...(inputRecord === undefined ? {} : { inputRecord }),
    ...(invocation === undefined ? {} : { invocation }),
    ...(request === undefined ? {} : { request }),
    requests: kernel.requestRows(authority.sessionId),
    ...(request === undefined || env.ports.requestDomainRevisions === undefined
      ? {}
      : { domainRevisions: env.ports.requestDomainRevisions(request) }),
  };
}

export function requestCommand(
  handle: ActivationHandle,
  requestId: string,
  inputId: string,
  payload: SessionTransition.Payload,
): Effect.Effect<{ readonly resolution: string }, AdmissionFailure> {
  const attempt = () => Effect.gen(function* () {
    const { kernel, authority, env } = handle;
    const row = kernel.row(authority.sessionId);
    const decision = decideRequestTransition(
      {
        version: 1,
        sessionId: authority.sessionId,
        inputId,
        at: env.clock(),
        expectedRevision: row.revision,
        authority: { owner: authority.owner, fence: authority.fence },
        payload,
      },
      requestSnapshot(handle, requestId, inputId, row),
      env.ports.approvalPolicy.recentOpen,
    );
    const intake =
      decision.receive === undefined
        ? []
        : [receivedMessageAction({ ...decision.receive, at: decision.receive.createdAt })];
    if (decision.actions.length > 0) {
      yield* commitIn(handle, {
        sessionId: authority.sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now: env.clock(),
        expectedRevision: row.revision,
        actions: [...decision.actions, ...intake],
        state: row.state,
        ...(decision.requestCount === undefined ? {} : { requestCount: decision.requestCount }),
      });
    }
    return { resolution: decision.resolution, committed: decision.actions.length > 0 };
  });
  return Effect.gen(function* () {
    const result = yield* retryRevision(attempt);
    if (result.committed) {
      handle.env.ports.onRequestReady?.(handle.authority.sessionId);
      yield* drain(handle);
    }
    return { resolution: result.resolution };
  }).pipe(Effect.catchIf(
    (error): error is LedgerError | SessionError => !(error instanceof AdmissionFailure),
    (error) => Effect.die(error),
  ));
}

export function createSessionEntityRunTurn(
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  scope: Scope.Scope,
): SessionEntityPorts["runTurn"] {
  return (input) => Effect.gen(function* () {
    const { kernel, authority, decision } = input;
    const { admission, runTurn, seal } = createEntityTurn(kernel, authority, runner, runtime, scope, (turn) => (turnInput) =>
      input.detach(turn(turnInput).pipe(Effect.asVoid)).pipe(
        Effect.as<SessionRunnerResult>({ kind: "waiting", reason: "live_wait", alarmIds: [], text: "" }),
      ));
    const recovery = createSessionRecovery(kernel, authority.sessionId, runtime, runtime.clock, runtime.entropy, {
      awaitRetainedRunner: () => Effect.void, runTurn, seal,
      commitSession: admission.commitSession, createExecutionLedger: admission.createExecutionLedger, consumeNoopDeliveries: admission.consumeNoopDeliveries,
    });
    switch (decision.kind) {
      case "start": return void (yield* admission.startTurn());
      case "recover": return void (yield* recovery.resumeTurn(decision.open));
      case "resume": return void (yield* recovery.resumeInterrupted(decision.item));
    }
  });
}

type EntityTurnRun = ReturnType<typeof createSessionTurn>["runTurn"];

/** A fresh controller at the activation fence, its session turn, and the admission that opens it. */
export function createEntityTurn(
  kernel: SessionKernel,
  authority: SessionEntityAuthority,
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  scope: Scope.Scope,
  admit: (runTurn: EntityTurnRun) => EntityTurnRun = (runTurn) => runTurn,
): {
  readonly admission: ReturnType<typeof createSessionAdmission>;
  readonly runTurn: EntityTurnRun;
  readonly seal: ReturnType<typeof createSessionTurn>["seal"];
} {
  const state: SessionControllerState = {
    active: undefined, controller: undefined, fence: authority.fence,
    closed: false, terminalFrozen: false, released: false, successor: undefined,
    retainedRunner: undefined, rawSlots: createRawSlots(), activeApprovals: undefined,
  };
  const turn = createSessionTurn(kernel, authority.sessionId, runner, runtime, state, authority.owner, runtime.clock, runtime.entropy, scope, {
    createExecutionLedger: (...args) => admission.createExecutionLedger(...args),
    evaluatePromptPolicies: (...args) => admission.evaluatePromptPolicies(...args),
    consumePolicyBlockedDeliveries: (...args) => admission.consumePolicyBlockedDeliveries(...args),
    hibernate: () => Effect.void,
  });
  const runTurn = admit(turn.runTurn);
  const admission = createSessionAdmission(kernel, authority.sessionId, runtime, state, authority.owner, runtime.clock, runtime.entropy, { awaitRetainedRunner: () => Effect.void, runTurn, seal: turn.seal });
  return { admission, runTurn, seal: turn.seal };
}
