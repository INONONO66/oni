import { AppInvariantError } from "../invariant";
import { Core } from "@openomni/agent";
type SessionHandle = Core.SessionHandle;
type SessionRunner = Core.SessionRunner;
type SessionEntityPorts = Core.SessionEntityPorts;
type ObservationPublishFailure = Core.ObservationPublishFailure;
import { type ChannelStore, createActorRegistry, createChannelGrantStore, createChannelInstanceStore, createPersonStore, createSecretStore, openChannelStore } from "@openomni/channels";
import { Context, Deferred, Effect, Exit, Layer } from "effect";

/**
 * Cluster plane composition (W5.2 #1197 plan §1): the core host (`Core.openLedger`)
 * owns the catalog, the session files, the single-node runner and the Session
 * entity under one Scope; the app projects its channel-facing stores over the
 * same catalog handle. The cluster is host + mailbox + clock only; durability
 * is the ledger's hash chain.
 */

/** Services the cluster host contributes to the app runtime (entity client access). */
export type ClusterServices = Core.ClusterServices;

/** Per-session ledger file path — the one place the layout is spelled (core-owned). */
export const sessionFilePath = Core.sessionFilePath;

export type SessionKernel = Core.SessionKernel;

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
  readonly secrets: ReturnType<typeof createSecretStore>;
  readonly channelGrants: ReturnType<typeof createChannelGrantStore>;
}

/**
 * The app's ledger plane (W5.2 F1): the core-owned store plane plus the
 * catalog-backed channel store plane. Built once at the composition root and
 * threaded explicitly — no module-level state.
 */
export interface AppLedgerPlane extends Core.LedgerPlane {
  /** Channels-owned store plane (#1317) attached to the catalog's database handle. */
  readonly channel: ChannelStore;
  readonly stores: AppCatalogStores;
}

/**
 * #1317: the channel-facing tables ride the same catalog file, but their
 * schema and adapters are channels-owned — attached here, once per plane,
 * without adopting the ledger's lifecycle (closing the plane closes the file).
 */
export function withChannelStores(ledger: Core.LedgerPlane, now: () => number): AppLedgerPlane {
  const channel = openChannelStore(ledger.catalogDatabase, now);
  return {
    ...ledger,
    channel,
    stores: {
      actors: createActorRegistry(channel),
      persons: createPersonStore(channel),
      instances: createChannelInstanceStore(channel),
      secrets: createSecretStore(channel),
      channelGrants: createChannelGrantStore(channel),
    },
  };
}

export class AppLedger extends Context.Service<AppLedger, AppLedgerPlane>()(
  "@openomni/openomni/AppLedger",
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
export interface SessionEntityPortsSlot {
  readonly ports: SessionEntityPorts;
  bind(ports: SessionEntityPorts): void;
}

export function createSessionEntityPortsSlot(): SessionEntityPortsSlot {
  let bound: SessionEntityPorts | undefined;
  const ready = Deferred.makeUnsafe<void>();
  const resolve = (): SessionEntityPorts => {
    if (bound === undefined) throw new AppInvariantError("session entity ports are not bound yet");
    return bound;
  };
  return {
    bind: (ports) => {
      if (bound !== undefined) throw new AppInvariantError("session entity ports are already bound");
      bound = ports;
      Deferred.doneUnsafe(ready, Exit.succeed(undefined));
    },
    ports: {
      ready: Deferred.await(ready),
      // #1309: the policy is composition-owned data; reads delegate to the
      // bound ports (an activation awaits `ready` before any port call).
      get approvalPolicy() {
        return resolve().approvalPolicy;
      },
      runTurn: (input) => Effect.suspend(() => resolve().runTurn(input)),
      onRequestReady: (sessionId) => bound?.onRequestReady?.(sessionId),
      requestDomainRevisions: (request) => resolve().requestDomainRevisions?.(request) ?? {},
      sendAlarm: (sessionId, occurrence) =>
        Effect.suspend(() => resolve().sendAlarm?.(sessionId, occurrence) ?? Effect.void),
      // #1254 H3: live-arm registration delegates late like the other ports.
      // An activation awaits `ready` before any port call, so boot has bound.
      onLive: (sessionId, verbs) => resolve().onLive?.(sessionId, verbs) ?? (() => undefined),
      // #1254 H1: post-commit arm notices follow the same late binding.
      onArmed: (notice) => resolve().onArmed?.(notice),
      // #1254 S4: capability + keep-alive observation delegate late like the
      // turn port — purposes resolve against whatever boot bound (none = []).
      alarmCapability: {
        get purposes(): readonly string[] {
          return bound?.alarmCapability?.purposes ?? [];
        },
        wake: (fired, ctx) =>
          Effect.suspend(() => {
            const capability = resolve().alarmCapability;
            if (capability === undefined)
              return Effect.die(new AppInvariantError("alarm capability wake without a bound capability"));
            return capability.wake(fired, ctx);
          }),
      },
      onKeepAlive: (enabled) => bound?.onKeepAlive?.(enabled),
      // #1255 P3: the composed generation's deliver registrations and
      // capability journal kinds, read per call so a recompose propagates.
      get inputRegistrations(): readonly string[] | undefined {
        return bound?.inputRegistrations;
      },
      get capabilityKinds(): readonly string[] | undefined {
        return bound?.capabilityKinds;
      },
    },
  };
}

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
}

export interface SessionLivePlane {
  get(sessionId: string): LiveTurnEntry | undefined;
  /** Sessions with a turn currently running in this process (shutdown join set). */
  ids(): readonly string[];
  /** Publishes the turn's live surfaces for the runner's lifetime; nested turns keep the outermost entry. */
  wrapRunner(sessionId: string, runner: SessionRunner): SessionRunner;
}

export function createSessionLivePlane(): SessionLivePlane {
  const entries = new Map<string, LiveTurnEntry>();
  return {
    get: (sessionId) => entries.get(sessionId),
    ids: () => [...entries.keys()],
    wrapRunner: (sessionId, runner) => (input) =>
      Effect.suspend(() => {
        const entry: LiveTurnEntry = { approvals: undefined, boundary: input.boundary, ledger: input.ledger };
        entries.set(sessionId, entry);
        return runner({
          ...input,
          bindApprovals: (approvals) => {
            entry.approvals = approvals;
            input.bindApprovals?.(approvals);
          },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entries.get(sessionId) === entry) entries.delete(sessionId);
            }),
          ),
        );
      }),
  };
}

/**
 * Out-of-turn request authority over a possibly-live activation (W5.2 F5):
 * `createSessionRequests` adopts a fresh fence when no registry handle exists,
 * which would steal a running entity turn's authority and kill its wave. The
 * borrowing kernel view lives with the request authority in the agent package
 * so the decision seam and its regression tests share one implementation.
 */
export const requestAuthorityKernel = Core.requestAuthorityKernel;
