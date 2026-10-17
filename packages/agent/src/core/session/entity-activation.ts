import type * as SessionHandleStore from "../store/fence";
import { CommitRefused, FenceRefused, SessionNotFound, type LedgerError } from "../store/errors";
import { canonicalJson, PlainObjectSchema, type LedgerAction } from "@openomni/protocol";
import { z } from "zod";
import { Cause, Context, Effect, Option, type Scope, type Semaphore } from "effect";
import { Entity, type Envelope } from "effect/cluster";
import type { SessionEntityAuthority, SessionEntityPorts } from "./run";
import { AdmissionFailure, AlarmRpc, DeliverRpc, ReadRpc, ResolveRpc } from "../journal/messages";
import { armAction, ArmRefused, type AlarmChainReads, type AlarmDrainConfig, type AlarmFired, type AlarmSendRefused, type ArmVerb } from "../ports/alarm";
import { isReservedAlarmPurpose } from "@openomni/protocol";

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

export type SessionRequest = Envelope.Request<SessionRpcs>;

export type SessionReplier = Entity.Replier<SessionRpcs>;

export interface ActivationHandle {
  readonly env: SessionEntityEnv;
  readonly kernel: SessionKernel;
  readonly authority: SessionEntityAuthority;
  readonly drain: AlarmDrainConfig;
  readonly scope: Scope.Scope;
    readonly gate: Semaphore.Semaphore;
    readonly live: { current: object | undefined };
    readonly closing: { current: boolean };
  readonly forwards: ForwardState;
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>;
    readonly resumeSend?: (occurrence: AlarmFired) => Effect.Effect<void>;
}

/** The activation's one forwarder: latest unsent occurrence per alarm id (a re-arm replaces it), last sent per id, and the sent occurrences a timed re-arm orphaned (each folds `stale` when it fires; `maxArmed` bounds them). */
export interface ForwardState {
  readonly queued: Map<string, { readonly occurrence: AlarmFired; readonly onRefused: "retire" | "ignore" }>;
  readonly sent: Map<string, string>;
  readonly orphans: Set<string>;
  running: boolean;
}

export function forwardState(): ForwardState {
  return { queued: new Map(), sent: new Map(), orphans: new Set(), running: false };
}

export function rotateActivationFence(env: SessionEntityEnv, kernel: SessionKernel, sessionId: string): number {
  try {
    return env.catalog.rotateFence(sessionId);
  } catch (error) {
    if (!(error instanceof SessionNotFound)) throw error;
    const row = kernel.row(sessionId);
    env.catalog.indexSession({
      id: sessionId,
      parentId: row.parentId,
      role: row.role,
      createdAt: env.clock(),
      hasRequests: kernel.requestRows(sessionId).length > 0,
    });
    return env.catalog.rotateFence(sessionId);
  }
}

export function adoptFence(kernel: SessionKernel, authority: SessionEntityAuthority): Effect.Effect<void, LedgerError> {
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

export function commitIn(
  handle: ActivationHandle,
  input: Parameters<SessionKernel["commit"]>[0],
): ReturnType<SessionKernel["commit"]> {
  return handle.kernel.commit(input).pipe(
    Effect.tap(() =>
      enqueueForwards(
        handle,
        input.actions.flatMap((action) => {
          const fired = armedOccurrenceOf(action);
          return fired === undefined ? [] : [{ occurrence: fired, onRefused: "ignore" as const }];
        }),
      ),
    ),
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
      }).pipe(
        Effect.catchIf((error) => error instanceof ArmRefused && error.code === "stale_activation", () => Effect.void),
        Effect.orDie,
        Effect.asVoid,
      );
    }),
  );
}

/** Re-sends a moved occurrence keyed on its new time; a closing activation leaves it to the next walk. */
export function sendQuietTick(handle: ActivationHandle, occurrence: AlarmFired): Effect.Effect<void> {
  return enqueueForwards(handle, [{ occurrence, onRefused: "retire" }]);
}

/** Queues occurrences on the one forwarder, forking it only when none runs. */
function enqueueForwards(
  handle: ActivationHandle,
  entries: readonly { readonly occurrence: AlarmFired; readonly onRefused: "retire" | "ignore" }[],
): Effect.Effect<void> {
  const send = handle.env.ports.sendAlarm;
  if (send === undefined || handle.closing.current || entries.length === 0) return Effect.void;
  return Effect.suspend(() => {
    const { forwards } = handle;
    for (const entry of entries) {
      forwards.queued.delete(entry.occurrence.alarmId);
      forwards.queued.set(entry.occurrence.alarmId, entry);
    }
    if (forwards.running) return Effect.void;
    forwards.running = true;
    return Effect.forkIn(
      forwardLoop(handle, send).pipe(
        Effect.onExit((exit) => Effect.sync(() => {
          if (exit._tag === "Failure") forwards.running = false;
        })),
      ),
      handle.scope,
    ).pipe(Effect.asVoid);
  });
}

/** Clears `running` in the same step that observes an empty queue, so a later enqueue always forks. */
function takeForward(handle: ActivationHandle) {
  const { forwards } = handle;
  const first = forwards.queued.entries().next();
  if (first.done === true || handle.closing.current) {
    forwards.queued.clear();
    forwards.running = false;
    return undefined;
  }
  forwards.queued.delete(first.value[0]);
  return first.value[1];
}

function forwardLoop(
  handle: ActivationHandle,
  send: NonNullable<SessionEntityPorts["sendAlarm"]>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (;;) {
      const entry = takeForward(handle);
      if (entry === undefined) return;
      const { occurrence } = entry;
      if (handle.kernel.armedAlarm(occurrence.alarmId)?.occurrenceId !== occurrence.occurrenceId) continue;
      handle.forwards.sent.set(occurrence.alarmId, occurrence.occurrenceId);
      yield* sendArmedOccurrence(handle, send, occurrence, entry.onRefused);
    }
  });
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

/** Under the gate the store-close finalizer takes: an arm completes (commit and tap) before the store closes, or sees `closing` and refuses `stale_activation`, leaving the occurrence to the next activation's resend walk. */
export function entityArmVerb(handle: ActivationHandle): ArmVerb {
  const verb = ungatedArmVerb(handle);
  return (input) =>
    handle.gate.withPermits(1)(Effect.suspend(() =>
      handle.closing.current ? Effect.fail(new ArmRefused({ code: "stale_activation" })) : verb(input),
    ));
}

/** One arm's budget: a new chain needs an `armed_alarms` slot; a timed re-arm of a sent occurrence orphans it and needs an orphan slot. Returns the orphaned id. */
function armBudget(
  handle: ActivationHandle,
  alarmId: string,
  at: number | null,
  latest: { readonly occurrenceId: string } | undefined,
): Effect.Effect<string | undefined, ArmRefused> {
  const { kernel, drain: config, forwards } = handle;
  if (at === null) return Effect.succeed(undefined);
  if (latest === undefined)
    return kernel.armedCount() >= config.maxArmed ? Effect.fail(new ArmRefused({ code: "alarm_budget" })) : Effect.succeed(undefined);
  if (forwards.sent.get(alarmId) !== latest.occurrenceId) return Effect.succeed(undefined);
  return forwards.orphans.size >= config.maxArmed
    ? Effect.fail(new ArmRefused({ code: "alarm_budget" }))
    : Effect.succeed(latest.occurrenceId);
}

function ungatedArmVerb(handle: ActivationHandle): ArmVerb {
  const { kernel, authority, env, forwards } = handle;
  return (input) =>
    retryRevision(() => Effect.gen(function* () {
      if (isReservedAlarmPurpose(input.purpose) || input.purpose === "rescan")
        return yield* new ArmRefused({ code: "reserved_purpose" });
      const alarmId = input.alarmId ?? `${authority.sessionId}:${input.purpose}`;
      const latest = armedChainReads(handle).latestArm(alarmId);
      const orphan = yield* armBudget(handle, alarmId, input.at, latest);
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
      if (orphan !== undefined) forwards.orphans.add(orphan);
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

export function armedChainReads(handle: ActivationHandle): AlarmChainReads {
  const { kernel } = handle;
  return {
    latestArm: (alarmId) => {
      const row = kernel.armedAlarm(alarmId);
      return row === undefined ? undefined : { occurrenceId: row.occurrenceId, at: row.fireAt };
    },
    settled: (occurrenceId) =>
      kernel.actionById(`${occurrenceId}:delivered`) !== undefined ||
      kernel.actionById(`${occurrenceId}:exhausted`) !== undefined,
  };
}

export function resendArmedAlarms(handle: ActivationHandle): Effect.Effect<void> {
  if (handle.env.ports.sendAlarm === undefined || handle.closing.current) return Effect.void;
  return enqueueForwards(handle, handle.kernel.armedAlarms().map((row) => ({ occurrence: row, onRefused: "retire" as const })));
}

export function armResumeOnPassivation(handle: ActivationHandle): Effect.Effect<void> {
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
