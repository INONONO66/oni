
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
import { createSessionRecovery } from "./recovery";
import { type SessionAdmissionSnapshot, type SessionEntityAuthority, type SessionEntityPorts, type SessionControllerState, type ResolvedSessionRuntime, type SessionRunner, type SessionRunnerResult, createSessionTurn } from "./run";
import { deliveryActions, receivedMessageAction } from "./commit";
import { createRawSlots } from "./gate/decide";
import { decideRequestTransition } from "./request";
import { AdmissionFailure, type AlarmOccurrence, type AlarmReceipt, AlarmRpc, DeadlineAlarmBody, DeliverBody, type DeliverReceipt, DeliverRefused, DeliverRpc, type ReadPage, ReadRpc, ResolveRefused, ResolveRpc } from "./messages";
import { alarmDisposition, armAction, ArmRefused, firedAction, MAX_OCCURRENCE_STRIKES, type AlarmChainReads, type AlarmDrainConfig, type AlarmFired, type AlarmSendRefused, type AlarmWakeContext, AlarmWakeError, type ArmVerb } from "./alarm";
import { isReservedAlarmPurpose } from "@openomni/protocol";
import { renderReadModel } from "./read";
import { restoreSessionHistory, RestoreRefused, type HydratedSessionHistory } from "../inspect/history";

// ─── from cluster/kernel-registry.ts (#1247) ───
/**
 * The handle-scoped kernel as a declaration-nameable interface: the ledger
 * alias is a `ReturnType` projection whose parameter types stay private to the
 * ledger, so exported types here must reference it through this name.
 *
 * NOTE (W5.2 #1197 plan §3): the `SessionKernelService` Context tag over this
 * shape lands together with its first production reader (the handle plane,
 * wave 3) - the boundary law refuses tags nothing reads (R9), and every
 * wave-2 consumer receives the kernel explicitly from the entity activation.
 */
export interface SessionKernel extends SessionHandleStore.SessionKernel {}

// ─── from cluster/session-entity.ts (#1247) ───
/** Store-handle types by position on the public kernel factory (the ledger index re-export lands with wave 3). */
type SessionStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[0];
type CatalogStoreHandle = Parameters<typeof SessionHandleStore.createSessionKernel>[1];

/** What one runner process provides to every Session activation. */
export interface SessionEntityEnv {
  /** Stable writer identity this runner stamps into `lease_owner` (audit only; the fence authorizes). */
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

/** Exported for the writer-fiber unit tests; composed only by `createSessionEntityLayer`. */
export interface ActivationHandle {
  readonly env: SessionEntityEnv;
  readonly kernel: SessionKernel;
  readonly authority: SessionEntityAuthority;
  /** Loop consumption + passivation values (D3); supplied by the composition root. */
  readonly drain: AlarmDrainConfig;
  /** The activation's scope: detached turn remainders fork here. */
  readonly scope: Scope.Scope;
  /** Serializes journal appends between the writer fiber and a detached turn's continuation. */
  readonly gate: Semaphore.Semaphore;
  /** Token of the currently detached turn; set before the fork, cleared when its body exits. */
  readonly live: { current: object | undefined };
  /** Set by the first-run close finalizer: no new fibers fork past it. */
  readonly closing: { current: boolean };
  /** Toggles the cluster keep-alive latch around a detached turn. */
  readonly keepAlive: (enabled: boolean) => Effect.Effect<void>;
  /**
   * Persist-and-return send through the entity's own Alarm door
   * (`discard: true`): completes once the occurrence envelope is durable,
   * never awaiting the reply — the one send a CLOSING activation may make.
   */
  readonly resumeSend?: (occurrence: AlarmFired) => Effect.Effect<void>;
}

/**
 * Rotates the catalog fence for this activation (F5). An unindexed but
 * materialized session file self-heals into the catalog from its own row;
 * a session absent from both planes stays a typed refusal.
 */
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

/**
 * Adopts the rotated catalog fence into the session file (F5): the file CAS
 * accepts only a strictly newer fence. A file fence at or beyond the target
 * means a later activation won: this one is stale.
 */
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

/**
 * Re-read the session row after a competing writer wins the revision CAS
 * (#1254 S4): bounded to three attempts, then the typed
 * `AdmissionFailure{code: revision}` — never an unbounded in-process spin.
 */
export function retryRevision<A, E>(attempt: () => Effect.Effect<A, E>): Effect.Effect<A, E | AdmissionFailure> {
  const refused = (error: E): error is E & CommitRefused =>
    error instanceof CommitRefused && error.reason === "revision";
  return Effect.suspend(attempt).pipe(
    Effect.retry({ while: refused, times: 2 }),
    Effect.catchIf(refused, () => Effect.fail(new AdmissionFailure({ code: "revision" }))),
  );
}

/** One received-message envelope on its way to the journal (#1313). */
interface ReceivedEnvelope {
  readonly messageId: string;
  readonly content: string;
  readonly origin: string;
}

/**
 * The exact journal action `appendReceived` would commit for one envelope at
 * `at` (#1256 H-3: a deferred input's `after` cursor rides the row INTENT —
 * the protocol `action` declaration — so it merges into the origin object).
 */
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

/**
 * The one replayed-key check (#1313). A key already on the journal replays as
 * the existing receipt only when the envelope would commit the same row bytes
 * — the candidate is hashed at the stored row's chain position (its
 * `prevHash`/`ts`/`ordinal` belong to the original commit, not the payload)
 * with the writer's own digest. A differing payload is the typed
 * `idempotency_conflict`; neither outcome appends anything.
 */
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

/** Idempotent receive (F4): a redelivered envelope resolves to its existing chain action; a conflicting one is the typed `idempotency_conflict` (#1313). */
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
    // The interrupt row carries the writer-owned `running -> interrupted`
    // transition; any other state drains the control as a no-op delivery.
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

/**
 * The entity's one commit door (#1254 S4): every append the activation itself
 * makes goes through here, and each committed `alarm{arm}` with a live `at`
 * is forwarded to the composed DeliverAt door as its minted occurrence
 * (daemon-forked: the persisted send's reply arrives at `fireAt`, long after
 * this activation may have passivated). Detached turn bodies commit through
 * the same wrapped kernel handed to the turn port.
 */
function commitIn(
  handle: ActivationHandle,
  input: Parameters<SessionKernel["commit"]>[0],
): ReturnType<SessionKernel["commit"]> {
  return handle.kernel.commit(input).pipe(
    Effect.tap(() => forwardArmedOccurrences(handle, input.actions)),
  );
}

/**
 * One armed-occurrence send with the H2 refusal contract (#1254). A typed
 * `AlarmSendRefused` is permanent: on the activation RESEND walk nobody else
 * can answer it, so the chain retires with `reason: "send_refused"` (the
 * post-commit notice closes any native handle). On the fresh-arm FORWARD the
 * committing wave's verb OWNS the refusal (#1254 r2 H2): the watch verb
 * awaits its own install and, on any refusal after its first committed arm
 * (a refused timeout arm, a refused install), retires exactly the chains it
 * committed — and the retiring arm's post-commit notice closes any native
 * handle this forward's install created in the meantime. Retiring here too
 * would double-retire the chain, so the forward drops the refusal. Any other failure
 * is logged and the armed row stands: the durable index plus the boot sweep
 * is the recovery of last resort. A refused RETIRE is a wiring defect and dies.
 */
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

/** Reconstructs the minted occurrence from a committed arm append and forwards it. */
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
  // Scoped to the activation: the envelope persists before the reply wait,
  // so a passivation interrupting the waiting fiber never loses the send.
  return Effect.forkIn(
    Effect.forEach(occurrences, (fired) => sendArmedOccurrence(handle, send, fired, "ignore"), { discard: true }),
    handle.scope,
  ).pipe(Effect.asVoid);
}

/** A live arm append (`at: null` retires the chain and forwards nothing). */
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

/** Commits `<id>:delivery` no-op records so consumed interrupts/resumes leave the fold. */
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

/**
 * Detached turn remainder (W5.2 S4): the port hands back the post-boundary
 * body; it forks under the activation scope so the delivering RPC acks at
 * the durable boundary. The continuation re-enters the drain when the turn
 * ends, picking up backlog that arrived after the turn's last boundary.
 * While the turn is live the cluster keep-alive latch is held (#1254 S4):
 * a running model/tool step never passivates; a turn parked at
 * `turn{terminal: waiting}` releases the latch and may passivate.
 */
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
        // A detached turn's failure has no awaiting RPC to surface through;
        // log it loud (a stale fence here means another authority took the
        // session over — the chain recovers on the next activation).
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

/** What one backlog drain resolved to; `refused` carries the typed refusal fact (issue #1245). */
export type SessionDrainOutcome =
  | { readonly kind: "stop" }
  | { readonly kind: "refused"; readonly refusal: SessionAdmissionRefused }
  | { readonly kind: "turn" };

/**
 * Backlog drain (F4): consume-decisions are folded here; the first admitted
 * turn decision is handed to the composition-owned turn port, which reaches
 * its own durable boundary before the caller's ack; the remainder of the
 * turn runs detached (see `detachTurn`). While a detached turn is live the
 * drain is a no-op — the turn's own boundaries consume fresh backlog and
 * its continuation re-drains at the end.
 */
function drain(handle: ActivationHandle): Effect.Effect<SessionDrainOutcome, LedgerError | SessionError> {
  const { authority, kernel, env } = handle;
  const detach = (body: Effect.Effect<void, SessionError>) => detachTurn(handle, body);
  return handle.gate.withPermits(1)(Effect.gen(function* () {
    // #1253 turn end consumption: after a turn seals, the loop re-decides so a
    // pending `followUp` backlog starts its follow-up turn before the ack.
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

/** The admission-shaped row one `deliver` proposes; never persisted as-is. */
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

/**
 * `deliver` (#1253, #1313): the one input door. The kind is checked against
 * the composed `inputRegistrations` port (unbound is the typed `seam_missing`,
 * never a core fallback), a replayed `idempotencyKey` resolves to the existing
 * seq as success with zero new facts only when its payload matches the stored
 * row (a differing payload is the typed `idempotency_conflict`), and a refused
 * admission is a typed rejection (`unknown_kind | missing_key | closed |
 * denied | idempotency_conflict | seam_missing`), never a success ack. An
 * admitted input is appended as its own journal row and the loop wakes.
 */
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
    // Unguarded by construction: every activation already read this row
    // (rotateActivationFence / adoptFence) and no API deletes one, so a
    // session absent from both planes never reaches this handler — it dies at
    // activation (pinned by rpc-surface "absent from both planes"). `closed`
    // stays a reserved refusal code for the wire contract.
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

/**
 * `resolve` (#1253): settle one open request. A missing request is
 * `unknown_request`, a settled one `already_resolved` — both typed, both with
 * zero new journal facts. A redelivered `inputId` replays through the pure
 * request authority's dedup instead of refusing.
 */
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

/**
 * `alarm` (#1254 S4): one occurrence through the chain-guarded fold, then
 * purpose dispatch. The four loop-reserved purposes are consumed by the loop
 * itself (`retry`/`resume` wake the drain; `deadline` expires its request iff
 * still open; `step_watchdog` is reserved — no step budget exists today, so
 * nothing arms it and a delivered one only wakes the drain). Any other
 * purpose dispatches to the composed alarm capability; an unregistered
 * purpose folds to a recorded `fired{stale}` fact with zero execution.
 */
function alarmOccurrence(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
): Effect.Effect<AlarmReceipt, AdmissionFailure> {
  return Effect.gen(function* () {
    // #1254 S3: `rescan` is entity-internal — activating the entity already
    // resent every armed occurrence exactly once; the occurrence itself
    // appends no fact and is never a registrable purpose.
    if (occurrence.purpose === "rescan") return { outcome: "delivered" as const };
    const disposition =
      handle.kernel.actionById(`${occurrence.alarmId}:arm:${occurrence.armSeq}`) === undefined
        ? { op: "skip" as const, reason: "unknown" as const }
        : alarmDisposition(armedChainReads(handle), occurrence);
    if (disposition.op === "skip") {
      yield* appendFiredAlarm(handle, occurrence, "stale");
      return { outcome: "stale" as const };
    }
    // Strike first (own transaction, no journal row); at `MAX_OCCURRENCE_STRIKES` settle unexecuted.
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
    return yield* capabilityWake(handle, occurrence);
  }).pipe(Effect.catchIf(
    (error): error is LedgerError => !(error instanceof AdmissionFailure),
    (error) => Effect.die(error),
  ));
}

/** Deadline wake (#1254 S4): expires the named request iff it is still open. */
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

/**
 * Capability wake dispatch (#1254 S4): a registered purpose runs with chain
 * reads, the budgeted `arm` verb and the core-owned `prompt` verb, then the
 * loop records `fired{outcome: <returned>}` and — for `delivered` — wakes the
 * drain. An unregistered purpose or a typed wake failure folds to a recorded
 * `fired{stale}` fact.
 */
function capabilityWake(
  handle: ActivationHandle,
  occurrence: AlarmOccurrence,
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
    const wake = yield* capability.wake(fired, wakeContext(handle, occurrence)).pipe(
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

/** The wake context one capability dispatch receives (#1254 S4). */
function wakeContext(handle: ActivationHandle, occurrence: AlarmOccurrence): AlarmWakeContext {
  return {
    sessionId: handle.authority.sessionId,
    reads: armedChainReads(handle),
    arm: entityArmVerb(handle),
    now: handle.env.clock(),
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

/**
 * The budgeted arm verb (#1254 S4, D3): refuses reserved purposes and refuses
 * `alarm_budget` once the durable armed index holds `maxArmed` rows. The arm
 * commits through the entity's one commit door, which forwards the minted
 * occurrence to the DeliverAt sender.
 */
function entityArmVerb(handle: ActivationHandle): ArmVerb {
  const { kernel, authority, env, drain: config } = handle;
  return (input) =>
    retryRevision(() => Effect.gen(function* () {
      if (isReservedAlarmPurpose(input.purpose) || input.purpose === "rescan")
        return yield* new ArmRefused({ code: "reserved_purpose" });
      const alarmId = input.alarmId ?? `${authority.sessionId}:${input.purpose}`;
      const latest = armedChainReads(handle).latestArm(alarmId);
      // The budget bounds the index, so only an arm that ADDS a row consults
      // it: a retire (`at: null`) deletes, a re-arm of an armed chain upserts.
      // A full budget must never pin a chain that wants to retire or move.
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
      // #1254 H1: post-commit notice — the composition root moves its native
      // source handle onto this arm BEFORE any next hit can resend the old,
      // now-superseded occurrence (which would fold stale in the dedupe).
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
        // #1254 r2 H3: the bounded revision CAS exhausting and a fence-stale
        // commit (a successor took the session over — this activation is no
        // longer the writer) are typed refusals the caller must see. Schema
        // refusals and unknown ledger errors stay invariants and die.
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

/** Chain reads over the durable `armed_alarms` index (#1254 S3). */
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

/**
 * Activation resend (#1254 S3/S4): every row of the durable `armed_alarms`
 * index goes back out as its ORIGINAL occurrence through the composed
 * DeliverAt door — the occurrence id is the cluster dedupe key, so a live
 * duplicate folds there. Forked, and bounded to exactly once per activation:
 * the rescan RPC that may have woken this entity does NOT resend again, so a
 * resend can never re-trigger itself under load.
 */
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

/** The four restore log annotations: the telemetry's only consumer (#1347). */
function restoreAnnotations(telemetry: HydratedSessionHistory["telemetry"]) {
  return {
    restoreRows: telemetry.rows,
    restoreBytes: telemetry.bytes,
    restorePages: telemetry.pages,
    restoreMs: telemetry.ms,
  };
}

/**
 * The activation restore (#1347): fold the suffix after the latest checkpoint
 * under `maxTailBytes` once and log the cost. The typed budget refusal arrives
 * in the error channel and still logs the work done; the activation proceeds,
 * since the writer bounds every tail it appends and the runner's own reads
 * are unbounded. Any other failure is logged, as before, never fatal here.
 */
function logRestoredHistory(handle: ActivationHandle): Effect.Effect<void> {
  const { kernel, authority, env } = handle;
  return restoreSessionHistory(kernel, authority.sessionId, { now: env.clock }).pipe(
    Effect.flatMap(({ telemetry }) =>
      Effect.annotateLogs(
        Effect.logInfo(`session restored: ${authority.sessionId}`),
        restoreAnnotations(telemetry),
      ),
    ),
    Effect.catchIf(RestoreRefused.isInstance, (refused) =>
      Effect.annotateLogs(
        Effect.logWarning(`session restore refused (${refused.data.code}): ${authority.sessionId}`),
        restoreAnnotations(refused.data.telemetry),
      ),
    ),
    Effect.catchCause((cause) => Effect.logError(`session restore failed: ${authority.sessionId}`, cause)),
  );
}

/**
 * `read` (#1253): one model page from the journal fold. A pure, bounded
 * projection over committed history — it appends nothing and never wakes the
 * loop. Pagination follows the chain's own revision cursor.
 */
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

/** The recorded firing fact (#1254); idempotent on `<occurrenceId>:<outcome>`. */
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


/**
 * One request command through the pure request authority (C3). The command's
 * `inputId` is the durable idempotency key; a reply intake from the decision
 * is committed as a received-message chain action in the same batch.
 */
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
      // A turn recovered by this activation may be parked on the request
      // (it read `open` before this commit); ring it before the drain, which
      // defers to that live turn.
      handle.env.ports.onRequestReady?.(handle.authority.sessionId);
      yield* drain(handle);
    }
    return { resolution: result.resolution };
  }).pipe(Effect.catchIf(
    (error): error is LedgerError | SessionError => !(error instanceof AdmissionFailure),
    (error) => Effect.die(error),
  ));
}

/**
 * Passivation boundary (#1254 S4): with unconsumed input left behind, the
 * closing activation arms the reserved `resume` purpose — alarmId
 * `<sessionId>:resume`, `at = now + idleMs`, superseding the previous resume
 * occurrence — so the session durably re-wakes and continues the same open
 * turn from the journal. Commit failures are logged, never thrown: the
 * durable armed index plus the boot sweep is the recovery of last resort.
 */
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
        // The activation scope is closing: no fork can outlive it, so this
        // one send goes through the discard door — it returns once the
        // occurrence envelope is durable and never awaits the reply.
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

// ─── #1254 S4: the single writer fiber ───

const isPromptDeliver = (request: SessionRequest): boolean =>
  request.tag === "Deliver" &&
  (request as Envelope.Request<typeof DeliverRpc>).payload.kind === "prompt";

/**
 * The admission writer (#1254 S4): ONE fiber owns admission and every journal
 * append the entity itself makes. RPC handlers only enqueue envelopes; this
 * loop serves them in arrival order, with one D3 consumption rule — after
 * `alarmsBeforePrompt` consecutive alarm wakes, a queued prompt delivery is
 * served first. `read` never blocks the writer: it forks as a pure
 * projection. At scope close the loop's finalizer answers every queued
 * request with `AdmissionFailure{code: shutdown}` — the persisted envelopes
 * redeliver to the next activation.
 */
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

  // D3: an alarm at the head with the alarm budget spent yields to the first
  // queued prompt delivery, if one is already waiting.
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
        return alarmOccurrence(handle, req.payload).pipe(
          Effect.exit,
          Effect.flatMap((exit) => replier.complete(req, exit)),
        );
      }
      case "Read": {
        // Off the writer path: a pure projection never queues behind appends.
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

/**
 * One activation per session (plan §3): open the per-session store, rotate the
 * catalog fence, adopt it into the file lease, resend the armed-alarm index
 * exactly once, and run the single writer fiber over the entity's envelope
 * queue (#1254 S4). A refused rotation means a later activation exists; dying
 * hands the mailbox back to the cluster. `maxIdleTime` is D3's `idleMs`: an
 * idle activation passivates, arming `resume` when unconsumed input remains.
 */
export function createSessionEntityLayer(drainConfig: AlarmDrainConfig) {
  return SessionEntity.toLayerQueue(
    Effect.gen(function* () {
      const env = yield* SessionEntityContext;
      // A redelivered message can activate a session before the composition
      // root bound the real ports; hold the activation until it has.
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
            // Persistence refusals are logged, never thrown: the armed index
            // plus the boot sweep is the recovery of last resort.
            Effect.catchCause((cause) =>
              Effect.logError(`resume occurrence send failed: ${sessionId}`, cause),
            ),
          ),
      };
      // #1254 S4 passivation boundary: arm `resume` for unconsumed input.
      // Registered before the writer's own finalizer never runs — finalizers
      // are LIFO, so this runs after the queue drain and before store close.
      yield* Effect.addFinalizer(() => armResumeOnPassivation(handle));
      // #1254 H3: hand this activation's budgeted arm verb to the composition
      // root — the ONE committing arm path the app's capability verbs
      // delegate to. Registered before the armed resend so a send-refusal
      // retire never races the registration window; released at passivation.
      // The turn token (#1254 r2 H3): the activation owns exactly the turn
      // currently open in its journal. The token is NOT activation-unique —
      // recovery retains `open.turnId`, so a successor owns the same token as
      // the activation it replaced (#1254 r3 H1); the registry binds each
      // tool-facing verb to the activation live at its creation and refuses
      // `stale_activation` once this registration is replaced.
      const releaseLive = env.ports.onLive?.(sessionId, {
        arm: entityArmVerb(handle),
        ownsTurn: (turnId) => kernel.latestOpenTurn(sessionId)?.turnId === turnId,
      });
      if (releaseLive !== undefined) yield* Effect.addFinalizer(() => Effect.sync(releaseLive));
      yield* logRestoredHistory(handle);
      // #1254 S3: restore scheduling — resend every armed occurrence (forked,
      // exactly once per activation).
      yield* resendArmedAlarms(handle);
      yield* drain(handle).pipe(Effect.orDie);
      return (queue: Queue.Dequeue<SessionRequest>, replier: SessionReplier) =>
        writerLoop(handle, queue, replier);
    }),
    { maxIdleTime: drainConfig.idleMs },
  );
}

/**
 * The real turn port for the Session entity (W5.2 F6): one admitted decision
 * runs through the same admission/turn machinery the in-process controller
 * uses, against the activation's kernel and pinned fence. The entity already
 * owns receipt, dedupe and authority; this port only reaches the durable turn
 * boundary and never re-adopts the fence. The admission paths commit that
 * boundary (deliveries + turn envelope, state `running`) before invoking the
 * turn runner, so the runner handed to the admission detaches its body via
 * `input.detach` (W5.2 S4): the delivering RPC acks at the boundary and the
 * model/tool remainder runs under the activation scope instead.
 */
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
    // The synthetic result never persists: seals ride the detached body, and
    // every entity admission path returns the runner result to a void sink.
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
