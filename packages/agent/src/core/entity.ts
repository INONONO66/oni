import * as SessionHandleStore from "./store/fence";
import { computeActionHash, storedActionRow } from "./store/action-hash";
import { CommitRefused, FenceRefused, SessionNotFound, type LedgerError } from "./store/errors";
import { parsePlainJson } from "./store/json";
import { canonicalJson, Delivery, PlainObjectSchema, PlainValueSchema, SessionTransition, type LedgerAction } from "@openomni/protocol";
import { z } from "zod";
import { Cause, Context, Effect, Exit, Option, Queue, Schema, type Scope, Semaphore } from "effect";
import { Entity, type Envelope, type Sharding } from "effect/cluster";
import { LeaseLost, SessionAdmissionRefused, type SessionError } from "./failure";
import { createSessionAdmission, decideSessionAdmission } from "./admission";
import { createSessionRecovery, logRestoredHistory } from "./recovery";
import { type SessionAdmissionSnapshot, type SessionEntityAuthority, type SessionEntityPorts, type SessionControllerState, type ResolvedSessionRuntime, type SessionRunner, type SessionRunnerResult, createSessionTurn } from "./run";
import { deliveryActions, receivedMessageAction } from "./commit";
import { createRawSlots } from "./gate/decide";
import { decideRequestTransition } from "./request";
import { AdmissionFailure, type AlarmOccurrence, type AlarmReceipt, AlarmRpc, DeadlineAlarmBody, DeliverBody, type DeliverReceipt, DeliverRefused, DeliverRpc, type ReadPage, ReadRpc, ResolveRefused, ResolveRpc } from "./messages";
import { alarmDisposition, armAction, ArmRefused, firedAction, MAX_OCCURRENCE_STRIKES, type AlarmChainReads, type AlarmDrainConfig, type AlarmFired, type AlarmSendRefused, type AlarmWakeContext, AlarmWakeError, type ArmVerb } from "./alarm";
import { isReservedAlarmPurpose } from "@openomni/protocol";
import { renderReadModel } from "./read";

export interface SessionKernel extends SessionHandleStore.SessionKernel {}

type SessionStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[0];
type CatalogStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[1];

export interface SessionEntityEnv {
    readonly owner: string;
  readonly clock: () => number;
  readonly catalog: CatalogStoreHandle;
  readonly openSession: (sessionId: string) => SessionStoreHandle;
  readonly ports: SessionEntityPorts;
}

export class SessionEntityContext extends Context.Service<SessionEntityContext, SessionEntityEnv>()(
  "@openomni/agent/cluster/SessionEntityContext",
) {}

export const SessionEntity = Entity.make("Session", [DeliverRpc, ResolveRpc, AlarmRpc, ReadRpc]);

type SessionRpcs = typeof DeliverRpc | typeof ResolveRpc | typeof AlarmRpc | typeof ReadRpc;
type SessionRequest = Envelope.Request<SessionRpcs>;
type SessionReplier = Entity.Replier<SessionRpcs>;

export interface ActivationHandle {
  readonly env: SessionEntityEnv;
  readonly kernel: SessionKernel;
  readonly authority: SessionEntityAuthority;
  readonly drain: AlarmDrainConfig;
  readonly scope: Scope.Scope;
    readonly gate: Semaphore.Semaphore;
    readonly live: { current: object | undefined };
    readonly closing: { current: boolean };
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>;
    readonly resumeSend?: (occurrence: AlarmFired) => Effect.Effect<void>;
}

function rotateActivationFence(env: SessionEntityEnv, kernel: SessionKernel, sessionId: string): number {
  try {
    return env.catalog.rotateFence(sessionId);
  } catch (error) {
    if (!(error instanceof SessionNotFound)) throw error;
    const row = kernel.row(sessionId);
    env.catalog.indexSession({ id: sessionId, parentId: row.parentId, role: row.role, createdAt: env.clock() });
    return env.catalog.rotateFence(sessionId);
  }
}

function adoptFence(kernel: SessionKernel, authority: SessionEntityAuthority): Effect.Effect<void, LedgerError> {
  const { sessionId, owner, fence } = authority;
  return Effect.suspend(() => {
    const current = kernel.row(sessionId);
    if (current.fence === fence && current.fenceOwner === owner) return Effect.void;
    if (current.fence >= fence)
      return Effect.fail(new FenceRefused({
        sessionId,
        reason: "stale",
        holder: current.fenceOwner,
        fence: current.fence,
        expiresAt: null,
      }));
    return kernel.adoptFence({ sessionId, owner, fence }).pipe(Effect.asVoid);
  });
}

export function retryRevision<A, E>(attempt: () => Effect.Effect<A, E>): Effect.Effect<A, E | AdmissionFailure> {
  const refused = (error: E): error is E & CommitRefused =>
    error instanceof CommitRefused && error.reason === "revision";
  return Effect.suspend(attempt).pipe(
    Effect.retry({ while: refused, times: 2 }),
    Effect.catchIf(refused, () => Effect.fail(new AdmissionFailure({ code: "revision" }))),
  );
}

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
): Effect.Effect<{ readonly ordinal: number; readonly actionHash: string } | undefined, DeliverRefused> {
  return Effect.suspend(() => {
    const existing = handle.kernel.actionById(message.messageId);
    if (existing === undefined) return Effect.succeed(undefined);
    const candidate = receivedActionFor(
      handle.authority.sessionId, kind, message, existing.ts, delivery, after,
    );
    const replayHash = computeActionHash(
      storedActionRow(candidate, existing.prevHash, existing.ordinal),
    );
    return replayHash === existing.actionHash
      ? Effect.succeed({ ordinal: existing.ordinal, actionHash: existing.actionHash })
      : Effect.fail(new DeliverRefused({ code: "idempotency_conflict" }));
  });
}

function appendReceived(
  handle: ActivationHandle,
  kind: Delivery.Kind,
  message: ReceivedEnvelope,
  delivery?: "steer" | "followUp",
  after?: number,
): Effect.Effect<{ readonly ordinal: number; readonly actionHash: string; readonly deduped: boolean }, LedgerError | AdmissionFailure | DeliverRefused> {
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
    return { ordinal: receipt.action.ordinal, actionHash: receipt.action.actionHash, deduped: false };
  }));
}

function commitIn(
  handle: ActivationHandle,
  input: Parameters<SessionKernel["commit"]>[0],
): ReturnType<SessionKernel["commit"]> {
  return handle.kernel.commit(input).pipe(
    Effect.tap(() => forwardArmedOccurrences(handle, input.actions)),
  );
}

function sendArmedOccurrence(
  handle: ActivationHandle,
  send: NonNullable<SessionEntityPorts["sendAlarm"]>,
  occurrence: AlarmFired,
  onRefused: "retire" | "ignore",
): Effect.Effect<void> {
  const sessionId = handle.authority.sessionId;
  return send(sessionId, occurrence).pipe(
    Effect.catchCause((cause) => {
      const refused: Option.Option<AlarmSendRefused> = Cause.findErrorOption(cause);
      if (Option.isNone(refused))
        return Effect.logError(`armed alarm send failed: ${sessionId}`, cause);
      if (onRefused === "ignore") return Effect.void;
      return entityArmVerb(handle)({
        purpose: occurrence.purpose,
        at: null,
        alarmId: occurrence.alarmId,
        supersedes: occurrence.occurrenceId,
        sourceKey: occurrence.sourceKey,
        payload: { reason: "send_refused", detail: refused.value.reason },
      }).pipe(Effect.orDie, Effect.asVoid);
    }),
  );
}

function forwardArmedOccurrences(
  handle: ActivationHandle,
  actions: readonly LedgerAction.Append[],
): Effect.Effect<void> {
  const send = handle.env.ports.sendAlarm;
  if (send === undefined || handle.closing.current) return Effect.void;
  const occurrences = actions.flatMap((action) => {
    const fired = armedOccurrenceOf(action);
    return fired === undefined ? [] : [fired];
  });
  if (occurrences.length === 0) return Effect.void;
  return Effect.forkIn(
    Effect.forEach(occurrences, (fired) => sendArmedOccurrence(handle, send, fired, "ignore"), { discard: true }),
    handle.scope,
  ).pipe(Effect.asVoid);
}

const ArmAppendIntent = z.object({
  op: z.literal("arm"),
  at: z.number(),
  alarmId: z.string().min(1),
  purpose: z.string().min(1),
  sourceKey: z.string().min(1),
  payload: PlainObjectSchema.optional(),
});
const ArmAppendEffect = z.object({ occurrenceId: z.string().min(1) });

function armedOccurrenceOf(action: LedgerAction.Append): AlarmFired | undefined {
  if (action.kind !== "alarm") return undefined;
  const intent = ArmAppendIntent.safeParse(action.intent.value);
  const effect = ArmAppendEffect.safeParse(action.effect.value);
  if (!intent.success || !effect.success) return undefined;
  const { at, alarmId, purpose, sourceKey, payload } = intent.data;
  const armSeq = Number(action.id.slice(`${alarmId}:arm:`.length));
  if (!Number.isFinite(armSeq)) return undefined;
  return {
    occurrenceId: effect.data.occurrenceId,
    purpose,
    alarmId,
    armSeq,
    sourceKey,
    payload: canonicalJson(payload ?? {}),
    fireAt: at,
  };
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
    const token = {};
    handle.live.current = token;
    yield* handle.keepAlive(true);
    yield* Effect.forkIn(
      body.pipe(
        Effect.ensuring(Effect.suspend(() => {
          if (handle.live.current !== token) return Effect.void;
          handle.live.current = undefined;
          return handle.keepAlive(false);
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

function drain(handle: ActivationHandle): Effect.Effect<SessionDrainOutcome, LedgerError | SessionError> {
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
const decodeDeadlineBody = Schema.decodeUnknownSync(DeadlineAlarmBody);

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

function deliver(
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
    const body = decodeDeliverBody(parsePlainJson(payload.body));
    const deliveryKind: Delivery.Kind =
      payload.kind === "prompt"
        ? "prompt"
        : payload.kind === "action"
          ? "action"
          : (body.control ??
            (yield* Effect.die(new Error("signal delivery without a control op"))));
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

function resolveCommand(
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
    const transition: SessionTransition.Payload =
      payload.outcome === "resolved"
        ? SessionTransition.Payload.parse(parsePlainJson(payload.payload))
        : {
            kind: "request.cancel",
            requestId: payload.requestId,
            principal: SessionTransition.Principal.parse(parsePlainJson(payload.payload)),
          };
    return yield* requestCommand(handle, payload.requestId, payload.inputId, transition);
  });
}

function alarmOccurrence(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
  promptReceived: () => void,
): Effect.Effect<AlarmReceipt, AdmissionFailure> {
  return Effect.gen(function* () {
    if (occurrence.purpose === "rescan") return { outcome: "delivered" as const };
    const disposition =
      handle.kernel.actionById(`${occurrence.alarmId}:arm:${occurrence.armSeq}`) === undefined
        ? { op: "skip" as const, reason: "unknown" as const }
        : alarmDisposition(armedChainReads(handle), occurrence);
    if (disposition.op === "skip") {
      yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    const strikes = handle.kernel.strikeArmedAlarm(occurrence.occurrenceId);
    if (strikes !== undefined && strikes >= MAX_OCCURRENCE_STRIKES) {
      yield* appendFiredAlarm(handle, occurrence, "exhausted");
      return { outcome: "delivered" as const };
    }
    if (isReservedAlarmPurpose(occurrence.purpose)) {
      if (occurrence.purpose === "deadline") yield* expireDeadline(handle, occurrence);
      yield* appendFiredAlarm(handle, occurrence, "delivered");
      yield* drain(handle).pipe(Effect.orDie);
      return { outcome: "delivered" as const };
    }
    return yield* capabilityWake(handle, occurrence, promptReceived);
  }).pipe(Effect.catchIf(
    (error): error is LedgerError => !(error instanceof AdmissionFailure),
    (error) => Effect.die(error),
  ));
}

function expireDeadline(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
): Effect.Effect<void, AdmissionFailure> {
  return Effect.suspend(() => {
    const body = decodeDeadlineBody(parsePlainJson(occurrence.payload));
    const request = handle.kernel.requestById(body.requestId);
    if (request === undefined || request.state !== "open") return Effect.void;
    return requestCommand(handle, body.requestId, `${body.requestId}:deadline`, {
      kind: "request.timeout",
      requestId: body.requestId,
    }).pipe(Effect.asVoid);
  });
}

function capabilityWake(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
  promptReceived: () => void,
): Effect.Effect<AlarmReceipt, LedgerError | AdmissionFailure> {
  return Effect.gen(function* () {
    const capability = handle.env.ports.alarmCapability;
    if (capability === undefined || !capability.purposes.includes(occurrence.purpose)) {
      yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    const fired: AlarmFired = {
      occurrenceId: occurrence.occurrenceId,
      purpose: occurrence.purpose,
      alarmId: occurrence.alarmId,
      armSeq: occurrence.armSeq,
      sourceKey: occurrence.sourceKey,
      payload: occurrence.payload,
      fireAt: occurrence.fireAt,
    };
    const wake = yield* capability.wake(fired, wakeContext(handle, occurrence, promptReceived)).pipe(
      Effect.catchTag("AlarmWakeError", (error) =>
        Effect.logWarning(`alarm wake failed: ${occurrence.occurrenceId} (${error.reason})`).pipe(
          Effect.as("stale" as const),
        ),
      ),
    );
    if (wake === "stale") {
      yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    yield* appendFiredAlarm(handle, occurrence, wake);
    if (wake === "delivered") yield* drain(handle).pipe(Effect.orDie);
    return { outcome: "delivered" as const };
  });
}

function wakeContext(handle: ActivationHandle, occurrence: AlarmOccurrence, promptReceived: () => void): AlarmWakeContext {
  return {
    sessionId: handle.authority.sessionId,
    reads: armedChainReads(handle),
    arm: entityArmVerb(handle),
    now: handle.env.clock(),
    deliver: (input) => Effect.suspend(() => {
      if (input.kind === "prompt") promptReceived();
      return deliver(handle, input);
    }),
    prompt: (input) =>
      appendReceived(handle, "prompt", {
        messageId: `${occurrence.occurrenceId}:prompt`,
        content: input.content,
        origin: canonicalJson(PlainValueSchema.parse({
          kind: "alarm",
          alarmId: occurrence.alarmId,
          occurrenceId: occurrence.occurrenceId,
          purpose: occurrence.purpose,
          sourceKey: occurrence.sourceKey,
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        })),
      }).pipe(
        Effect.map((receipt) => ({ seq: receipt.ordinal })),
        Effect.mapError(() => new AlarmWakeError({ purpose: occurrence.purpose, reason: "prompt_commit" })),
      ),
  };
}

function entityArmVerb(handle: ActivationHandle): ArmVerb {
  const { kernel, authority, env, drain: config } = handle;
  return (input) =>
    retryRevision(() => Effect.gen(function* () {
      if (isReservedAlarmPurpose(input.purpose) || input.purpose === "rescan")
        return yield* new ArmRefused({ code: "reserved_purpose" });
      const alarmId = input.alarmId ?? `${authority.sessionId}:${input.purpose}`;
      const latest = armedChainReads(handle).latestArm(alarmId);
      if (input.at !== null && latest === undefined && kernel.armedCount() >= config.maxArmed)
        return yield* new ArmRefused({ code: "alarm_budget" });
      const row = kernel.row(authority.sessionId);
      const armSeq = row.revision + 1;
      const supersedes = input.supersedes ?? latest?.occurrenceId ?? null;
      const { action, occurrenceId } = armAction({
        parentId: kernel.latestAction(authority.sessionId)?.id ?? null,
        sessionId: authority.sessionId,
        purpose: input.purpose,
        at: input.at,
        supersedes,
        alarmId,
        sourceKey: input.sourceKey,
        payload: input.payload,
        armSeq,
        ts: env.clock(),
      });
      yield* commitIn(handle, {
        sessionId: authority.sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now: env.clock(),
        expectedRevision: row.revision,
        actions: [action],
        state: row.state,
      });
      env.ports.onArmed?.({
        sessionId: authority.sessionId,
        purpose: input.purpose,
        alarmId,
        occurrenceId,
        armSeq,
        at: input.at,
        supersedes,
        sourceKey: input.sourceKey,
        payload: input.payload,
      });
      return { alarmId, occurrenceId, armSeq };
    })).pipe(Effect.catchIf(
      (error): error is Exclude<LedgerError | AdmissionFailure, never> => !(error instanceof ArmRefused),
      (error) => {
        if (error instanceof AdmissionFailure && error.code === "revision")
          return Effect.fail(new ArmRefused({ code: "revision" }));
        if (
          error instanceof FenceRefused ||
          (error instanceof CommitRefused && error.reason === "fence")
        )
          return Effect.fail(new ArmRefused({ code: "stale_activation" }));
        return Effect.die(error);
      },
    ));
}

function armedChainReads(handle: ActivationHandle): AlarmChainReads {
  const { kernel } = handle;
  return {
    latestArm: (alarmId) => {
      const row = kernel.armedAlarms().find((armed) => armed.alarmId === alarmId);
      return row === undefined ? undefined : { occurrenceId: row.occurrenceId, at: row.fireAt };
    },
    settled: (occurrenceId) =>
      kernel.actionById(`${occurrenceId}:delivered`) !== undefined ||
      kernel.actionById(`${occurrenceId}:exhausted`) !== undefined,
  };
}

function resendArmedAlarms(handle: ActivationHandle): Effect.Effect<void> {
  const send = handle.env.ports.sendAlarm;
  if (send === undefined || handle.closing.current) return Effect.void;
  const { kernel, scope } = handle;
  const rows = kernel.armedAlarms();
  if (rows.length === 0) return Effect.void;
  return Effect.forkIn(
    Effect.forEach(rows, (row) => sendArmedOccurrence(handle, send, row, "retire"), { discard: true }),
    scope,
  ).pipe(Effect.asVoid);
}

function readProjection(
  handle: ActivationHandle,
  payload: { readonly model: Parameters<typeof renderReadModel>[0]; readonly cursor: number },
): Effect.Effect<ReadPage> {
  const { kernel, authority } = handle;
  return Effect.sync(() => {
    const page = kernel.historyPage(authority.sessionId, { afterRevision: payload.cursor, limit: 256 });
    return {
      body: JSON.stringify(renderReadModel(payload.model, page.actions)),
      nextCursor: page.nextRevision,
    };
  });
}

function appendFiredAlarm(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
  outcome: "delivered" | "stale" | "exhausted",
): Effect.Effect<void, LedgerError | AdmissionFailure> {
  const { kernel, authority, env } = handle;
  const id = `${occurrence.occurrenceId}:${outcome}`;
  return retryRevision(() =>
    Effect.suspend(() => {
      if (kernel.actionById(id) !== undefined) return Effect.void;
      const row = kernel.row(authority.sessionId);
      const now = env.clock();
      return commitIn(handle, {
        sessionId: authority.sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now,
        expectedRevision: row.revision,
        actions: [
          firedAction({
            parentId: kernel.latestAction(authority.sessionId)?.id ?? null,
            sessionId: authority.sessionId,
            purpose: occurrence.purpose,
            alarmId: occurrence.alarmId,
            occurrenceId: occurrence.occurrenceId,
            outcome,
            ts: now,
          }),
        ],
        state: row.state,
      }).pipe(Effect.asVoid);
    }),
  );
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

function requestCommand(
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

function armResumeOnPassivation(handle: ActivationHandle): Effect.Effect<void> {
  return Effect.suspend(() => {
    const { kernel, authority, env, drain: config } = handle;
    if (kernel.pendingMessages(authority.sessionId).length === 0) return Effect.void;
    const alarmId = `${authority.sessionId}:resume`;
    return retryRevision(() => Effect.suspend(() => {
      const row = kernel.row(authority.sessionId);
      const { action, occurrenceId } = armAction({
        parentId: kernel.latestAction(authority.sessionId)?.id ?? null,
        sessionId: authority.sessionId,
        purpose: "resume",
        at: env.clock() + config.idleMs,
        supersedes: armedChainReads(handle).latestArm(alarmId)?.occurrenceId ?? null,
        alarmId,
        sourceKey: "resume",
        payload: {},
        armSeq: row.revision + 1,
        ts: env.clock(),
      });
      return kernel.commit({
        sessionId: authority.sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now: env.clock(),
        expectedRevision: row.revision,
        actions: [action],
        state: row.state,
      }).pipe(
        Effect.flatMap(() => {
          const armed = kernel.armedAlarms().find((armedRow) => armedRow.occurrenceId === occurrenceId);
          if (handle.resumeSend === undefined || armed === undefined) return Effect.void;
          return handle.resumeSend(armed);
        }),
      );
    })).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`resume arm at passivation failed: ${authority.sessionId}`, cause),
      ),
    );
  });
}

const isPromptDeliver = (request: SessionRequest): boolean =>
  request.tag === "Deliver" &&
  (request as Envelope.Request<typeof DeliverRpc>).payload.kind === "prompt";

export function writerLoop(
  handle: ActivationHandle,
  queue: Queue.Dequeue<SessionRequest>,
  replier: SessionReplier,
): Effect.Effect<never> {
  const buffer: SessionRequest[] = [];
  let alarmsSincePrompt = 0;

  const next: Effect.Effect<SessionRequest> = Effect.suspend(() => {
    const head = buffer.shift();
    return head === undefined ? Queue.take(queue) : Effect.succeed(head);
  });
  const select: Effect.Effect<SessionRequest> = next.pipe(
    Effect.flatMap((request) => {
      if (request.tag !== "Alarm" || alarmsSincePrompt < handle.drain.alarmsBeforePrompt)
        return Effect.succeed(request);
      return Queue.clear(queue).pipe(
        Effect.map((flushed) => {
          buffer.push(...flushed);
          const promptIndex = buffer.findIndex(isPromptDeliver);
          if (promptIndex === -1) return request;
          const prompt = buffer[promptIndex] as SessionRequest;
          buffer.splice(promptIndex, 1);
          buffer.unshift(request);
          return prompt;
        }),
      );
    }),
  );

  const serve = (request: SessionRequest): Effect.Effect<void> => {
    switch (request.tag) {
      case "Deliver": {
        const req = request as Envelope.Request<typeof DeliverRpc>;
        if (req.payload.kind === "prompt") alarmsSincePrompt = 0;
        return deliver(handle, req.payload).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Resolve": {
        const req = request as Envelope.Request<typeof ResolveRpc>;
        return resolveCommand(handle, req.payload).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Alarm": {
        const req = request as Envelope.Request<typeof AlarmRpc>;
        alarmsSincePrompt += 1;
        return alarmOccurrence(handle, req.payload, () => { alarmsSincePrompt = 0; }).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Read": {
        const req = request as Envelope.Request<typeof ReadRpc>;
        return Effect.forkIn(
          readProjection(handle, req.payload).pipe(
            Effect.exit,
            Effect.flatMap((exit) => replier.complete(req, exit)),
          ),
          handle.scope,
        ).pipe(Effect.asVoid);
      }
    }
  };

  const failShutdown = (request: SessionRequest): Effect.Effect<void> => {
    const failure = new AdmissionFailure({ code: "shutdown" });
    switch (request.tag) {
      case "Deliver":
        return replier.fail(request as Envelope.Request<typeof DeliverRpc>, failure);
      case "Resolve":
        return replier.fail(request as Envelope.Request<typeof ResolveRpc>, failure);
      case "Alarm":
        return replier.fail(request as Envelope.Request<typeof AlarmRpc>, failure);
      case "Read":
        return replier.fail(request as Envelope.Request<typeof ReadRpc>, failure);
    }
  };

  const drainOnClose = Effect.gen(function* () {
    handle.closing.current = true;
    const leftovers = [...buffer, ...(yield* Queue.clear(queue))];
    buffer.length = 0;
    yield* Effect.forEach(leftovers, failShutdown, { discard: true });
  });

  const loop = Effect.gen(function* () {
    for (;;) {
      const request = yield* select;
      yield* serve(request);
    }
  });

  return loop.pipe(Effect.ensuring(drainOnClose)) as Effect.Effect<never>;
}

export function createSessionEntityLayer(drainConfig: AlarmDrainConfig) {
  return SessionEntity.toLayerQueue(
    Effect.gen(function* () {
      const env = yield* SessionEntityContext;
      yield* env.ports.ready ?? Effect.void;
      const address = yield* Entity.CurrentAddress;
      const sessionId = address.entityId;
      const store = env.openSession(sessionId);
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()));
      const kernel = SessionHandleStore.createSessionKernel(store, env.catalog);
      const authority: SessionEntityAuthority = {
        sessionId,
        owner: env.owner,
        fence: rotateActivationFence(env, kernel, sessionId),
      };
      yield* adoptFence(kernel, authority).pipe(Effect.orDie);
      const scope = yield* Effect.scope;
      const gate = yield* Semaphore.make(1);
      const clusterServices = yield* Effect.context<Sharding.Sharding | Entity.CurrentAddress>();
      const makeClient = yield* SessionEntity.client;
      const client = makeClient(sessionId);
      const handle: ActivationHandle = {
        env,
        kernel,
        authority,
        drain: drainConfig,
        scope,
        gate,
        live: { current: undefined },
        closing: { current: false },
        keepAlive: (enabled) =>
          Effect.suspend(() => {
            env.ports.onKeepAlive?.(enabled);
            if (handle.closing.current) return Effect.void;
            return Entity.keepAlive(enabled).pipe(Effect.provideContext(clusterServices));
          }),
        resumeSend: (occurrence) =>
          client.Alarm(occurrence, { discard: true }).pipe(
            Effect.provideContext(clusterServices),
            Effect.catchCause((cause) =>
              Effect.logError(`resume occurrence send failed: ${sessionId}`, cause),
            ),
          ),
      };
      yield* Effect.addFinalizer(() => armResumeOnPassivation(handle));
      const releaseLive = env.ports.onLive?.(sessionId, {
        arm: entityArmVerb(handle),
        ownsTurn: (turnId) => kernel.latestOpenTurn(sessionId)?.turnId === turnId,
      });
      if (releaseLive !== undefined) yield* Effect.addFinalizer(() => Effect.sync(releaseLive));
      yield* logRestoredHistory(kernel, sessionId, env.clock);
      yield* resendArmedAlarms(handle);
      yield* drain(handle).pipe(Effect.orDie);
      return (queue: Queue.Dequeue<SessionRequest>, replier: SessionReplier) =>
        writerLoop(handle, queue, replier);
    }),
    { maxIdleTime: drainConfig.idleMs },
  );
}

export function createSessionEntityRunTurn(
  runner: SessionRunner,
  runtime: ResolvedSessionRuntime,
  scope: Scope.Scope,
): SessionEntityPorts["runTurn"] {
  return (input) => Effect.gen(function* () {
    const { kernel, authority, decision } = input;
    const state: SessionControllerState = {
      active: undefined, controller: undefined, fence: authority.fence,
      closed: false, terminalFrozen: false, released: false, successor: undefined,
      retainedRunner: undefined,
      rawSlots: createRawSlots(), activeApprovals: undefined,
    };
    const { runTurn, seal } = createSessionTurn(kernel, authority.sessionId, runner, runtime, state, authority.owner, runtime.clock, runtime.entropy, scope, {
      createExecutionLedger: (...args) => admission.createExecutionLedger(...args),
      evaluatePromptPolicies: (...args) => admission.evaluatePromptPolicies(...args),
      consumePolicyBlockedDeliveries: (...args) => admission.consumePolicyBlockedDeliveries(...args),
      hibernate: () => Effect.void,
    });
    const detachedRunTurn: typeof runTurn = (turnInput) =>
      input.detach(runTurn(turnInput).pipe(Effect.asVoid)).pipe(
        Effect.as<SessionRunnerResult>({ kind: "waiting", reason: "live_wait", alarmIds: [], text: "" }),
      );
    const admission = createSessionAdmission(kernel, authority.sessionId, runtime, state, authority.owner, runtime.clock, runtime.entropy, { awaitRetainedRunner: () => Effect.void, runTurn: detachedRunTurn, seal });
    const recovery = createSessionRecovery(kernel, authority.sessionId, runtime, runtime.clock, runtime.entropy, {
      awaitRetainedRunner: () => Effect.void, runTurn: detachedRunTurn, seal,
      commitSession: admission.commitSession, createExecutionLedger: admission.createExecutionLedger, consumeNoopDeliveries: admission.consumeNoopDeliveries,
    });
    switch (decision.kind) {
      case "start": return void (yield* admission.startTurn());
      case "recover": return void (yield* recovery.resumeTurn(decision.open));
      case "resume": return void (yield* recovery.resumeInterrupted(decision.item));
    }
  });
}
