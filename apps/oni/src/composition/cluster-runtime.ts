import { Bundle, Core } from "@oni/agent";
type SessionHandle = Core.SessionHandle;
type SessionRunner = Core.SessionRunner;
type ObservationPublishFailure = Core.ObservationPublishFailure;
import { type ChannelStore, createActorRegistry, createChannelGrantStore, createChannelInstanceStore, createMachineEnrollmentStore, createPersonStore, createSecretStore, openChannelStore } from "@oni/channels";
import { Context, Deferred, Effect, Exit, Layer, type Scope } from "effect";

/**
 * Cluster plane composition (W5.2 #1197 plan §1): the core host (`Core.openLedger`)
 * owns the catalog, the session files, the single-node runner and the Session
 * entity under one Scope; the app attaches its channel-facing stores to the
 * same catalog. Core owns session files, transactions and authority.
 */

/** Services the cluster host contributes to the app runtime (entity client access). */
export type ClusterServices = Core.ClusterServices;

export type SessionReadModel = Core.SessionReadModel;

/**
 * A publish that failed after its write committed is an incident for the
 * composition root's log, never a write failure: the receipt already left.
 */
export function reportObservationPublishFailure(failure: ObservationPublishFailure): void {
  console.error(`ledger observation publish failed: ${failure.actionId}`, failure.cause);
}

/** Catalog-backed durable stores the app composes tools and boot over. */
interface AppCatalogStores {
  readonly actors: ReturnType<typeof createActorRegistry>;
  readonly persons: ReturnType<typeof createPersonStore>;
  readonly instances: ReturnType<typeof createChannelInstanceStore>;
  readonly machineEnrollments: ReturnType<typeof createMachineEnrollmentStore>;
  readonly secrets: ReturnType<typeof createSecretStore>;
  readonly channelGrants: ReturnType<typeof createChannelGrantStore>;
}

/**
 * The app's ledger plane (W5.2 F1): the core-owned store plane plus the
 * catalog-backed channel store plane. Built once at the composition root and
 * threaded explicitly — no module-level state.
 */
export interface AppLedgerPlane extends Pick<Core.LedgerHost,
  "read" | "session" | "runtime" | "updatePolicy" | "policyState" | "transaction" | "close"
> {
  /** Channels-owned store plane (#1317) attached to the catalog's database handle. */
  readonly channel: ChannelStore;
  readonly stores: AppCatalogStores;
}

/**
 * #1317: the channel-facing tables ride the same catalog file, but their
 * schema and adapters are channels-owned — attached here, once per plane,
 * without adopting the ledger's lifecycle (closing the plane closes the file).
 */
export function withChannelStores(ledger: Core.LedgerHost, now: () => number): AppLedgerPlane {
  const { channel, machineEnrollments } = ledger.attach((database) => ({
    channel: openChannelStore(database, now),
    machineEnrollments: createMachineEnrollmentStore(database),
  }));
  return {
    read: ledger.read,
    session: ledger.session,
    runtime: ledger.runtime,
    updatePolicy: ledger.updatePolicy,
    policyState: ledger.policyState,
    transaction: ledger.transaction,
    close: ledger.close,
    channel,
    stores: {
      actors: createActorRegistry(channel),
      persons: createPersonStore(channel),
      instances: createChannelInstanceStore(channel),
      machineEnrollments,
      secrets: createSecretStore(channel),
      channelGrants: createChannelGrantStore(channel),
    },
  };
}

export class AppLedger extends Context.Service<AppLedger, AppLedgerPlane>()(
  "@oni/oni/AppLedger",
) {}

/** The app plane over the host's ledger: the host owns open and close. */
export function appLedgerLayer(now: () => number): Layer.Layer<AppLedger, never, Core.Ledger> {
  return Layer.effect(AppLedger, Effect.map(Core.Ledger, (ledger) => withChannelStores(ledger, now)));
}

/**
 * Late-bound entity ports (plan §1): the entity layer is composed before the
 * Resident exists, so the composition root hands the layer this slot and
 * binds the real ports once boot resolves them. An activation awaits `ready`
 * before its first port call (the cluster host redelivers a crashed
 * process's persisted messages as soon as it starts, before boot reaches the
 * binding); unbound use outside an activation dies typed — a wiring defect.
 */
export const createSessionEntityPortsSlot = Core.createSessionPortsSlot;

// ─── #1254 S3: boot alarm rescan ───

type AlarmSweepConfig = Core.AlarmSweepConfig;

/** One empty rescan wake (#1254 S3): entity-internal, appends no fact. */
export interface RescanOccurrence {
  readonly sessionId: string;
  readonly occurrence: {
    readonly occurrenceId: string;
    readonly purpose: "rescan";
    readonly alarmId: string;
    readonly armSeq: number;
    readonly sourceKey: "rescan";
    readonly payload: string;
    readonly fireAt: number;
  };
}

const DAY_MS = 86_400_000;

/**
 * Boot alarm rescan targets (#1254 S3): `sweep.full` rescans every session;
 * otherwise every `has_armed` session plus sessions idle for at least
 * `sweep.idleDays`. The occurrence is keyed `sessionId:rescan:<bootId>` so a
 * second boot is a new wake while one boot's duplicates fold in the cluster.
 */
export function rescanOccurrences(input: {
  readonly armedSessionIds: readonly string[];
  readonly sessions: readonly { readonly id: string; readonly lastActivityAt: number }[];
  readonly sweep: AlarmSweepConfig;
  readonly bootId: string;
  readonly now: number;
}): readonly RescanOccurrence[] {
  const targets = new Set<string>(input.armedSessionIds);
  for (const session of input.sessions) {
    if (input.sweep.full || input.now - session.lastActivityAt >= input.sweep.idleDays * DAY_MS) {
      targets.add(session.id);
    }
  }
  return [...targets].sort().map((sessionId) => ({
    sessionId,
    occurrence: {
      occurrenceId: `${sessionId}:rescan:${input.bootId}`,
      purpose: "rescan" as const,
      alarmId: `${sessionId}:rescan`,
      armSeq: 0,
      sourceKey: "rescan" as const,
      payload: "{}",
      fireAt: input.now,
    },
  }));
}

type SessionRunnerInput = Parameters<SessionRunner>[0];

/**
 * The composition's window into one live entity turn (W5.2 plan §1): the
 * entity runs turns inside its delivering RPC, so mid-turn interaction
 * (approval answers, durable interrupts) cannot ride a second RPC on the
 * serialized mailbox. The wrapped runner publishes the turn's approval gate
 * and boundary drain here for exactly the turn's lifetime.
 */
interface LiveTurnEntry {
  approvals: SessionHandle["approvals"] | undefined;
  readonly boundary: SessionRunnerInput["boundary"];
  /** The turn's own commit/transition port - request transitions ride the turn's fence. */
  readonly ledger: SessionRunnerInput["ledger"];
  /**
   * #1346: holds the turn open across one in-flight interrupt. The facade's
   * interrupt rides the entity's asynchronous `Deliver` door, so a turn whose
   * runner has already finished must not seal until every interrupt issued
   * while it was live has landed and been drained — the hold is taken
   * synchronously, before the first RPC hop, and released after the drain.
   */
  readonly hold: () => () => void;
}

export interface SessionLivePlane {
  get(sessionId: string): LiveTurnEntry | undefined;
  /** Sessions with a turn currently running in this process (shutdown join set). */
  ids(): readonly string[];
  /** Called after every turn leaves the plane; the drain gate waits on it rather than polling. */
  subscribe(listener: () => void): () => void;
  /** Publishes the turn's live surfaces for the runner's lifetime; nested turns keep the outermost entry. */
  wrapRunner(sessionId: string, runner: SessionRunner): SessionRunner;
}

/** The entity's external tool turn uses the same dispatcher and live-turn lifetime as the app runner. */
export function bindSessionToolTurn(
  turns: Effect.Success<Core.SessionHostRuntime["turns"]>,
  options: Core.SessionRuntimeOptions,
  scope: Scope.Scope,
  liveTurns: SessionLivePlane,
): NonNullable<Core.SessionEntityPorts["runTool"]> {
  return turns.tool((input, call) =>
    Bundle.createTurnDispatcher(input, options).pipe(
      Effect.flatMap((dispatcher) => dispatcher.execute(call, {
        sessionId: input.sessionId, turnId: input.turnId, signal: input.signal,
      })),
    ), scope, (runner) => (input) => liveTurns.wrapRunner(input.sessionId, runner)(input));
}

type EntityClient = Effect.Success<typeof Core.sessionClient>;
type InterruptFailure =
  | Effect.Error<ReturnType<ReturnType<EntityClient>["Deliver"]>>
  | Core.ExecutionError;

/** The facade interrupt's failure cause: a typed door refusal as `tag:code`, anything else stringified. */
export function interruptFailureCause(error: InterruptFailure): string {
  return error._tag === "DeliverRefused" || error._tag === "AdmissionFailure"
    ? `${error._tag}:${error.code}`
    : String(error);
}

export function createSessionLivePlane(): SessionLivePlane {
  const entries = new Map<string, LiveTurnEntry>();
  const listeners = new Set<() => void>();
  return {
    get: (sessionId) => entries.get(sessionId),
    ids: () => [...entries.keys()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    wrapRunner: (sessionId, runner) => (input) =>
      Effect.suspend(() => {
        let holds = 0;
        let settled = Deferred.makeUnsafe<void>();
        const entry: LiveTurnEntry = {
          approvals: undefined,
          boundary: input.boundary,
          ledger: input.ledger,
          hold: () => {
            if (holds === 0) settled = Deferred.makeUnsafe<void>();
            holds += 1;
            let released = false;
            return () => {
              if (released) return;
              released = true;
              holds -= 1;
              if (holds === 0) Deferred.doneUnsafe(settled, Exit.succeed(undefined));
            };
          },
        };
        entries.set(sessionId, entry);
        return runner({
          ...input,
          bindApprovals: (approvals) => {
            entry.approvals = approvals;
            input.bindApprovals?.(approvals);
          },
        }).pipe(
          // An interrupt that was issued while the runner was live lands and
          // drains before ANY exit (success, typed failure, interruption)
          // reaches the sealer: the drain consumed the row and aborted the
          // turn's signal, so a completed runner seals `interrupted` — never a
          // completed turn with a stray pending interrupt behind it.
          Effect.onExit(() => Effect.suspend(() => (holds === 0 ? Effect.void : Deferred.await(settled)))),
          Effect.map((result) => (input.signal.aborted ? { kind: "interrupted" as const, text: "" } : result)),
          Effect.ensuring(
            Effect.sync(() => {
              if (entries.get(sessionId) === entry) entries.delete(sessionId);
              for (const listener of listeners) listener();
            }),
          ),
        );
      }),
  };
}
