import { AppInvariantError } from "./invariant";
import { Core } from "@oni/agent";
import { makeLlmService } from "@oni/llm";
type Entropy = Core.Entropy;
type EntropySource = Core.EntropySource;
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
type SessionEntityPorts = Core.SessionEntityPorts;
type SessionError = Core.SessionError;
type GenerationLayers = Core.GenerationLayers;
import { AgentProcessLive } from "./agent-layers";
type LedgerError = Core.LedgerError;
type Llm = Core.Llm;
/** The composition root binds the call layer to the core port (#1352): the core declares `Llm`, `@oni/llm` answers it. */
export const LlmLive = Layer.sync(Core.Llm, () => makeLlmService());
import { pid } from "node:process";
import { type Clock, Context, Data, Effect, Layer, type ManagedRuntime, type Scope, flow } from "effect";
import { BunCrypto } from "./composition/cluster-crypto";
import {
  type AppLedger,
  appLedgerLayer,
  createSessionEntityPortsSlot,
  reportObservationPublishFailure,
  type ClusterServices,
} from "./composition/cluster-runtime";
import { resolveAlarmDrain } from "./config";
import { ComposedGeneration } from "./composition/composed";
import { GenerationLayersLive, HookConsultClock } from "./composition/generation-layers";
import { AppPointTable, composedPointTable } from "./composition/point-table";
import { captureNow, platformEntropy, wallClockLayer } from "./composition/platform";

export class AppLifecycleFailure extends Data.TaggedError("AppLifecycleFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return `${this.operation}: ${this.cause}`; }
}

export const lifecycleFailure = (operation: string) =>
  flow(String, (cause) => new AppLifecycleFailure({ operation, cause }));

export class AppScope extends Context.Service<AppScope, Scope.Scope>()(
  "@oni/oni/AppScope",
) {}

/**
 * The runtime-owned late-binding seam for the session entity's ports: the
 * entity layer always mounts (a runtime without it silently swallows every
 * delivery), and the composition root binds the real turn/timer ports here
 * once boot resolves them. Construction-time `entity` options pin the ports
 * instead; binding then is a wiring defect and dies loud.
 */
export class SessionEntityBinding extends Context.Service<
  SessionEntityBinding,
  { bind(ports: SessionEntityPorts): void }
>()("@oni/oni/SessionEntityBinding") {}

export interface AppRuntimeOptions {
  /** Catalog SQLite file (session index + cluster mailbox); absent = in-memory. */
  readonly catalogPath?: string;
  /** Directory of per-session ledger files; absent = in-memory session stores. */
  readonly sessionsDir?: string;
  /** Milliseconds of mailbox silence before a session entity passivates. */
  readonly entityIdleMs?: number;
  /**
   * D3 loop consumption values (#1254 S4); absent = `resolveAlarmDrain`
   * over `entityIdleMs` (the config module owns the defaults).
   */
  readonly alarmDrain?: Core.AlarmDrainConfig;
  /**
   * Where the SingleRunner keeps its cluster_* tables; defaults to the
   * catalog. A process child MUST pin ":memory:" — two runners on one
   * catalog file would fight over the same runner tables.
   */
  readonly clusterStoragePath?: string;
  /** Session entity activation; present once composition supplies the turn port. */
  readonly entity?: {
    readonly owner: string;
    readonly ports: SessionEntityPorts;
  };
  /** Injected wall clock (#1245); absent = the bootstrap-captured Effect Clock. */
  readonly now?: () => number;
  /**
   * `"injected"` provides the injected `now` to the cluster host too (#1255
   * P6), so persisted DeliverAt holds follow the test clock instead of the
   * platform clock. Default keeps the host on the platform clock: fixtures
   * that pin a small epoch rely on past-due envelopes delivering immediately.
   */
  readonly clusterClock?: "injected";
  /** Injected entropy source (#1245); absent = the platform CSPRNG. */
  readonly entropy?: EntropySource;
  /**
   * The Effect Clock hook consult deadlines run on (#1256 r5 H-2); absent =
   * the executing fiber's clock. Tests inject a TestClock so a hook call's
   * timeout advances deterministically instead of on wall time.
   */
  readonly hookClock?: Clock.Clock;
  readonly observations?: Context.Service.Shape<typeof ObservationSink>;
  readonly llm?: Layer.Layer<Llm>;
  /**
   * Effect logger provided under every runtime layer, so fibers the cluster host forks at
   * construction inherit it too; absent = the default console logger on stdout.
   */
  readonly logger?: Layer.Layer<never>;
  /** The composed-generation holder (#1255 P3): boot composes the manifest and injects it — THE one composition root. */
  readonly composed: Context.Service.Shape<typeof ComposedGeneration>;
  /** The capability registrations this composition selects (#1251); absent = every built-in this app ships. */
  readonly capabilities?: readonly Core.CapabilityPointRegistration[];
}

export function AppLive(options: AppRuntimeOptions) {
  const now = options.now === undefined ? captureNow : Effect.succeed(options.now);
  return Layer.unwrap(Effect.map(now, (captured) => appLayer(options, Layer.succeed(ComposedGeneration, options.composed), captured)));
}

function appLayer(options: AppRuntimeOptions, composed: Layer.Layer<ComposedGeneration>, now: () => number) {
  const entropy = options.entropy ?? platformEntropy();
  // The root observation bus is app-owned (#1249): a Layer whose Scope is the
  // runtime's lifetime. Injected fixture sinks mount as plain values.
  const sinkLayer: Layer.Layer<ObservationSink> =
    options.observations === undefined
      ? Core.observationBusLayer({ id: entropy.id, now })
      : Layer.succeed(ObservationSink, options.observations);
  return Layer.unwrap(Effect.gen(function* () {
    const observations = yield* ObservationSink;
    return wiredLayer(options, composed, now, entropy, observations);
  })).pipe(Layer.provideMerge(sinkLayer));
}

function wiredLayer(
  options: AppRuntimeOptions,
  composed: Layer.Layer<ComposedGeneration>,
  now: () => number,
  entropy: EntropySource,
  observations: Context.Service.Shape<typeof ObservationSink>,
) {
  const plane = appLedgerLayer(now);
  const process = AgentProcessLive(observations, entropy);
  const pointTable = Layer.succeed(AppPointTable, composedPointTable(options.capabilities));
  const consultClock =
    options.hookClock === undefined ? Layer.empty : Layer.succeed(HookConsultClock, options.hookClock);
  const generations = GenerationLayersLive.pipe(
    Layer.provideMerge(Layer.mergeAll(process, composed, plane, pointTable, consultClock)),
  );
  const hostClock =
    options.clusterClock === "injected" && options.now !== undefined
      ? wallClockLayer(now)
      : Layer.empty;
  const seam =
    options.entity === undefined
      ? (() => {
          const slot = createSessionEntityPortsSlot();
          return { owner: `oni:${pid}`, ports: slot.ports, bind: slot.bind };
        })()
      : {
          owner: options.entity.owner,
          ports: options.entity.ports,
          bind: (): void => {
            throw new AppInvariantError("session entity ports were fixed at runtime construction");
          },
        };
  // The core host: catalog, session files, runner storage and the Session
  // entity under the runtime's Scope. Product choices stay here: the clock,
  // the drain defaults, the incident log and the Bun crypto.
  const ledger: Layer.Layer<Core.Ledger | ClusterServices> = Core.openLedger({
    now,
    ...(options.catalogPath === undefined ? {} : { catalog: { path: options.catalogPath } }),
    ...(options.sessionsDir === undefined ? {} : { sessions: { dir: options.sessionsDir } }),
    observationSink: observations,
    onObservationFailure: reportObservationPublishFailure,
    owner: seam.owner,
    cluster: {
      storagePath: options.clusterStoragePath ?? options.catalogPath ?? ":memory:",
      entityIdleMs: options.entityIdleMs ?? 60_000,
    },
    drain:
      options.alarmDrain ??
      resolveAlarmDrain(
        options.entityIdleMs === undefined ? {} : { entityIdleMs: options.entityIdleMs },
      ),
    ports: seam.ports,
  }).pipe(Layer.orDie, Layer.provide(hostClock), Layer.provide(BunCrypto));
  const binding = Layer.succeed(SessionEntityBinding, { bind: seam.bind });
  const app = Layer.mergeAll(
    Layer.effect(AppScope, Effect.scope).pipe(Layer.provideMerge(generations)),
    options.llm ?? LlmLive,
    binding,
    pointTable,
  ).pipe(Layer.provideMerge(ledger));
  const root = options.now === undefined ? app : Layer.mergeAll(app, wallClockLayer(now));
  return options.logger === undefined ? root : root.pipe(Layer.provideMerge(options.logger));
}

export type AppServices =
  | Entropy
  | ObservationSink
  | AppLedger
  | AppPointTable
  | AppScope
  | Llm
  | ComposedGeneration
  | GenerationLayers
  | SessionEntityBinding
  | ClusterServices;
type AppRuntimeError = AppLifecycleFailure | LedgerError | SessionError;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppRuntimeError>;
