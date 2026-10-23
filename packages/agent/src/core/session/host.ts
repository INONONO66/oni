import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { Database } from "bun:sqlite";
import { type LedgerSession, type ObservationSink, SessionGeneration } from "@oni/protocol";
import { type Crypto, Data, Deferred, Duration, Effect, Exit, Layer, type Scope } from "effect";
import { SingleRunner } from "effect/cluster";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AlarmDrainConfig } from "../ports/alarm";
import {
  createSessionEntityLayer,
  createSessionEntityRunTurn,
  SessionEntity,
  SessionEntityContext,
} from "./entity";
import { AgentFailure, CommitFailed, thrownAsError } from "../ports/failure";
import { Ledger } from "../ports/ports";
import { adoptedExecutor, type ResolvedSessionRuntime, type SessionEntityPorts, type SessionRunner } from "./run";
import { type CatalogStore, openCatalogStore } from "../store/catalog";
import * as SessionHandleStore from "../store/fence";
import type { LedgerHandles } from "../store/services";
import { openSessionStore, readSessionFileSchemaVersion, SESSION_FILE_SCHEMA_VERSION, type SessionStore } from "../store/session-file";
import type { ObservationFailurePort } from "../store/storage/sqlite-l0-observation";
import { sessionIdProblem } from "./session-id";
import { sessionReadModel } from "../read-model/session";
import { configureAction, generationSnapshot, materializationSeed } from "../store/configure";
import { createSession, type CreateSessionInput } from "./create";
import { forkSession, ForkRefused, type ForkInput } from "./fork";
import { createSessionRequests, requestAuthorityKernel } from "./request";
import type { SessionRuntime } from "./runtime";

const ENTITY_REAPER_INTERVAL_MS = 5_000;

type SessionKernel = SessionHandleStore.SessionKernel;

/** The one place the layout is spelled; a path that leaves the sessions dir is refused before any open. */
export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  const path = join(sessionsDir, `${sessionId}.sqlite`);
  const problem =
    sessionIdProblem(sessionId) ??
    (dirname(resolve(path)) === resolve(sessionsDir) ? undefined : "session file escapes the sessions dir");
  if (problem !== undefined) throw refused("sessions", path, new Error(problem));
  return path;
}

export interface LedgerStoreConfig {
  /** The store plane never reads ambient time. */
  readonly now: () => number;
  /** Absent = an in-memory catalog. */
  readonly catalog?: { readonly path?: string };
  /** Absent = memoized in-memory stores shared with the entity. */
  readonly sessions?: { readonly dir?: string };
  readonly observationSink?: ObservationSink;
  /** Absent drops it. */
  readonly onObservationFailure?: ObservationFailurePort;
}

export interface LedgerPlane {
  readonly read: {
    readonly session: (sessionId: string) => ReturnType<typeof sessionReadModel>;
    readonly sessions: {
      readonly list: () => LedgerSession.Row[];
      readonly get: (sessionId: string) => LedgerSession.Row | undefined;
    };
    readonly index: CatalogStore["sessionIndex"];
    readonly armedSessionIds: CatalogStore["armedSessionIds"];
    readonly fact: (sessionId: string, key: string) => ReturnType<SessionStore["decisionFacts"]["head"]>;
  };
  session(sessionId: string): ReturnType<typeof ledgerSession>;
  /** Core mechanics receive these ports as a unit; the app never opens their handles. */
  readonly runtime: Pick<SessionRuntime, "openKernel" | "listSessions">;
  requests(runtime: SessionRuntime): ReturnType<typeof createSessionRequests>;
  readonly policies: CatalogStore["policies"];
  transaction<A>(operation: () => A): A;
  readonly catalog: CatalogStore;
  readonly catalogDatabase: Database;
  readonly handles: LedgerHandles;
  /** Both valid until the session's next passivation closes them: resolve per use, never hold across an await. */
  openKernel(sessionId: string): SessionKernel;
  /** `skip` names files the catalog proves hold nothing for `read`; an unindexed file is still opened. */
  scanSessions<A>(
    read: (kernel: SessionKernel, row: LedgerSession.Row) => A[],
    skip?: ReadonlySet<string>,
  ): A[];
  sessionStore(sessionId: string): SessionStore;
  releaseSession(sessionId: string): void;
  discardSession(sessionId: string): void;
  listSessions(): LedgerSession.Row[];
  turnPort(
    runner: SessionRunner,
    runtime: ResolvedSessionRuntime,
    scope: Scope.Scope,
  ): SessionEntityPorts["runTurn"];
  close(): void;
}

export { Ledger };

/** Application command port: entity activation, transport and mailbox ownership stay in Core. */
export const sessionClient = Effect.map(SessionEntity.client, (client) => (sessionId: string) => {
  const session = client(sessionId);
  return { Deliver: session.Deliver, Resolve: session.Resolve, Alarm: session.Alarm };
});

class SessionBindingError extends Data.TaggedError("SessionBindingError")<{
  readonly message: string;
}> {}

/** The host may activate before boot binds its product ports; readiness gates the first call. */
export function createSessionPortsSlot() {
  let bound: SessionEntityPorts | undefined;
  const ready = Deferred.makeUnsafe<void>();
  const resolve = (): SessionEntityPorts => {
    if (bound === undefined)
      throw new SessionBindingError({ message: "session entity ports are not bound yet" });
    return bound;
  };
  const ports: SessionEntityPorts = {
    ready: Deferred.await(ready),
    get approvalPolicy() { return resolve().approvalPolicy; },
    runTurn: (input) => Effect.suspend(() => resolve().runTurn(input)),
    onRequestReady: (id) => bound?.onRequestReady?.(id),
    requestDomainRevisions: (request) => resolve().requestDomainRevisions?.(request) ?? {},
    sendAlarm: (id, occurrence) =>
      Effect.suspend(() => resolve().sendAlarm?.(id, occurrence) ?? Effect.void),
    onLive: (id, verbs) => resolve().onLive?.(id, verbs) ?? (() => undefined),
    onArmed: (notice) => resolve().onArmed?.(notice),
    alarmCapability: {
      get purposes() { return bound?.alarmCapability?.purposes ?? []; },
      wake: (fired, context) => Effect.suspend(() => {
        const capability = resolve().alarmCapability;
        return capability === undefined
          ? Effect.die(new SessionBindingError({ message: "alarm capability wake without a bound capability" }))
          : capability.wake(fired, context);
      }),
    },
    onKeepAlive: (enabled) => bound?.onKeepAlive?.(enabled),
    get inputRegistrations() { return bound?.inputRegistrations; },
    get capabilityKinds() { return bound?.capabilityKinds; },
  };
  return {
    ports,
    bind: (next: SessionEntityPorts): void => {
      if (bound !== undefined)
        throw new SessionBindingError({ message: "session entity ports are already bound" });
      bound = next;
      Deferred.doneUnsafe(ready, Exit.succeed(undefined));
    },
  };
}

export class OpenRefused extends Data.TaggedError("OpenRefused")<{
  readonly code: "catalog" | "sessions";
  readonly path: string;
  readonly cause: Error;
  readonly message: string;
}> {}

function refused<E>(code: OpenRefused["code"], path: string, cause: E): OpenRefused {
  return new OpenRefused({
    code,
    path,
    cause: thrownAsError(cause),
    message: `ledger open refused (${code}): ${path}`,
  });
}

export interface LedgerConfig extends LedgerStoreConfig {
  /** Audit only; the fence authorizes. */
  readonly owner: string;
  readonly cluster: {
    /** `:memory:` isolates a process. */
    readonly storagePath: string;
    readonly entityIdleMs: number;
  };
  /** A late-bound slot's `ready` holds activations. */
  readonly drain: AlarmDrainConfig;
  readonly ports: SessionEntityPorts;
}

export type ClusterServices = Layer.Success<ReturnType<typeof SingleRunner.layer>>;

/** Catalog first, then sessions, so a refusal releases the catalog; caller owns `close`. */
export function openLedgerPlane(config: LedgerStoreConfig): LedgerPlane {
  const catalogPath = config.catalog?.path ?? ":memory:";
  let catalog: CatalogStore;
  try {
    catalog = openCatalogStore(catalogPath, {
      now: config.now,
      ...(config.observationSink === undefined ? {} : { observationSink: config.observationSink }),
    });
  } catch (cause) {
    throw refused("catalog", catalogPath, cause);
  }
  const sessionsDir = config.sessions?.dir;
  if (sessionsDir !== undefined) {
    try {
      mkdirSync(sessionsDir, { recursive: true });
    } catch (cause) {
      catalog.close();
      throw refused("sessions", sessionsDir, cause);
    }
  }
  return planeOver(catalog, sessionsDir, config);
}

function planeOver(
  catalog: CatalogStore,
  sessionsDir: string | undefined,
  config: LedgerStoreConfig,
): LedgerPlane {
  const sessionOptions = {
    now: config.now,
    ...(config.observationSink === undefined ? {} : { observationSink: config.observationSink }),
    ...(config.onObservationFailure === undefined
      ? {}
      : { onObservationFailure: config.onObservationFailure }),
  };
  const memo = new Map<string, { store: SessionStore; kernel: SessionKernel; newFile: boolean }>();
  function opened(sessionId: string) {
    let entry = memo.get(sessionId);
    if (entry === undefined) {
      const path = sessionsDir === undefined ? ":memory:" : sessionFilePath(sessionsDir, sessionId);
      const fresh = sessionsDir !== undefined && !existsSync(path);
      let store: SessionStore;
      try {
        store = openSessionStore(path, sessionOptions);
      } catch (cause) {
        throw refused("sessions", path, cause);
      }
      entry = { store, kernel: SessionHandleStore.createSessionKernel(store, catalog), newFile: fresh };
      memo.set(sessionId, entry);
    }
    return entry;
  }
  function releaseSession(sessionId: string): void {
    const entry = memo.get(sessionId);
    if (entry === undefined) return;
    memo.delete(sessionId);
    entry.store.close();
  }
  function openEntitySession(sessionId: string): SessionStore {
    const path = sessionFilePath(sessionsDir ?? "", sessionId);
    let store: SessionStore;
    try {
      store = openSessionStore(path, sessionOptions);
    } catch (cause) {
      throw refused("sessions", path, cause);
    }
    const view: SessionStore = Object.create(store, {
      close: { value: () => {
        store.close();
        releaseSession(sessionId);
      } },
    });
    return view;
  }
  function scanSessions<A>(
    read: (kernel: SessionKernel, row: LedgerSession.Row) => A[],
    skip?: ReadonlySet<string>,
  ): A[] {
    const live = [...memo].filter(([id, entry]) => entry.store.sessions.get(id) !== undefined && !skip?.has(id));
    if (sessionsDir === undefined) return live.flatMap(([id, entry]) => readRow(entry.kernel, id, ":memory:", read));
    return [...new Set([...catalog.sessionIds(), ...live.map(([id]) => id)])].flatMap((id) => {
      if (skip?.has(id)) return [];
      // A second handle's bootstrap would wait on a write transaction held through the memo.
      const entry = memo.get(id);
      const path = sessionFilePath(sessionsDir, id);
      if (entry !== undefined) return readRow(entry.kernel, id, path, read);
      // An index row without a file was never created: skipped, unlike a file that will not open.
      if (!existsSync(path)) return [];
      let store: SessionStore;
      try {
        store = openSessionStore(path, sessionOptions);
      } catch (cause) {
        throw refused("sessions", path, cause);
      }
      try {
        return readRow(SessionHandleStore.createSessionKernel(store, catalog), id, path, read);
      } finally {
        store.close();
      }
    });
  }
  const plane: LedgerPlane = {
    read: {
      session: (id) => sessionReadModel(opened(id).kernel),
      sessions: {
        list: () => scanSessions((_, row) => [row]),
        get: (id) => scanSessions((_, row) => row.id === id ? [row] : [])[0],
      },
      index: (id) => catalog.sessionIndex(id),
      armedSessionIds: () => catalog.armedSessionIds(),
      fact: (id, key) => opened(id).store.decisionFacts.head(key),
    },
    session: (id) => ledgerSession(
      plane, id, sessionsDir === undefined ? undefined : () => sessionFilePath(sessionsDir, id),
    ),
    runtime: {
      openKernel: (id) => plane.openKernel(id),
      listSessions: () => plane.listSessions(),
    },
    requests: (runtime) => createSessionRequests({
      ...runtime,
      openKernel: (id) => requestAuthorityKernel(plane.openKernel(id), id),
    }),
    policies: catalog.policies,
    transaction: catalog.transaction,
    catalog,
    catalogDatabase: catalog.database,
    handles: {
      catalog,
      // File mode: a fresh handle the entity closes on passivation. In-memory:
      // the plane's memoized store, retained so a successor continues the chain.
      openSession: (sessionId) =>
        sessionsDir === undefined
          ? retained(opened(sessionId).store)
          : openEntitySession(sessionId),
    },
    openKernel: (sessionId) => {
      const created = sessionsDir !== undefined && !memo.has(sessionId);
      const { kernel } = opened(sessionId);
      // Only the read that opened the store may end it; a live holder keeps its handle.
      return created
        ? { ...kernel, [SessionHandleStore.releaseSessionKernel]: () => releaseSession(sessionId) }
        : kernel;
    },
    scanSessions,
    sessionStore: (sessionId) => opened(sessionId).store,
    releaseSession,
    discardSession: (sessionId) => {
      const entry = memo.get(sessionId);
      if (entry?.newFile !== true || entry.store.sessions.get(sessionId) !== undefined) return;
      releaseSession(sessionId);
      if (sessionsDir !== undefined) rmSync(sessionFilePath(sessionsDir, sessionId));
    },
    listSessions: () => scanSessions((_, row) => [row]),
    turnPort: createSessionEntityRunTurn,
    close: () => {
      for (const entry of memo.values()) entry.store.close();
      memo.clear();
      catalog.close();
    },
  };
  return plane;
}

function readRow<A>(
  kernel: SessionKernel,
  id: string,
  path: string,
  read: (kernel: SessionKernel, row: LedgerSession.Row) => A[],
): A[] {
  let row: LedgerSession.Row;
  try {
    row = kernel.row(id);
  } catch (cause) {
    throw refused("sessions", path, cause);
  }
  return read(kernel, row);
}

/** `close` is a no-op: the plane closes the store, never the entity. */
function retained(store: SessionStore): SessionStore {
  const view: SessionStore = Object.create(store, { close: { value: () => undefined } });
  return view;
}

/** One opener, one release; a typed refusal fails the layer, any other throw is a defect. */
function ledgerLayer(config: LedgerStoreConfig): Layer.Layer<Ledger, OpenRefused> {
  return Layer.effect(
    Ledger,
    Effect.acquireRelease(
      Effect.suspend(() => {
        try {
          return Effect.succeed(openLedgerPlane(config));
        } catch (cause) {
          return cause instanceof OpenRefused ? Effect.fail(cause) : Effect.die(cause);
        }
      }),
      (plane) => Effect.sync(() => plane.close()),
    ),
  );
}

/** One Scope, released in reverse; sharding config is explicit, `SHARDING_*` env ignored. */
export function openLedger(
  config: LedgerConfig,
): Layer.Layer<Ledger | ClusterServices, OpenRefused, Crypto.Crypto> {
  const runner = SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMaxIdleTime: Duration.millis(
        Math.max(config.cluster.entityIdleMs, ENTITY_REAPER_INTERVAL_MS),
      ),
      entityMessagePollInterval: Duration.millis(100),
      entityReplyPollInterval: Duration.millis(100),
    },
  }).pipe(Layer.provide(SqliteClient.layer({ filename: config.cluster.storagePath })), Layer.orDie);
  const env = Layer.effect(
    SessionEntityContext,
    Effect.gen(function* () {
      const plane = yield* Ledger;
      return {
        owner: config.owner,
        clock: config.now,
        catalog: plane.catalog,
        openSession: plane.handles.openSession,
        ports: config.ports,
      };
    }),
  );
  return createSessionEntityLayer(config.drain).pipe(
    Layer.provide(env),
    Layer.provideMerge(runner),
    Layer.provideMerge(ledgerLayer(config)),
  );
}

interface ConfigureToolsRuntime extends Pick<ResolvedSessionRuntime, "authorizeConfigure" | "clock" | "entropy"> {
  readonly generations: Pick<ResolvedSessionRuntime["generations"], "configure">;
}

/** Prepare a typed genesis value for admission without opening a store. */
export function prepareSession(input: CreateSessionInput) {
  const { id, parentId, role, genesis } = input;
  const { tools, bundles, system, policyGeneration, manifestHash, ...identity } = genesis;
  return materializationSeed({ id, parentId, role, ...identity }, generationSnapshot({
    generation: 1, revertTo: 0, tools, bundles, system, policyGeneration,
    ...(manifestHash === undefined ? {} : { manifestHash }),
  }));
}

/** Host-owned operations close over store handles; callers supply product policy and values only. */
function ledgerSession(plane: LedgerPlane, sessionId: string, parentPath?: () => string) {
  return {
    create: (input: Omit<CreateSessionInput, "id">) => createSession(plane, { ...input, id: sessionId }),
    fork: (input: Omit<ForkInput, "from">) => Effect.suspend(() => {
      const version = parentPath === undefined
        ? SESSION_FILE_SCHEMA_VERSION
        : readSessionFileSchemaVersion(parentPath());
      if (version !== SESSION_FILE_SCHEMA_VERSION)
        return Effect.fail(new ForkRefused({
          sessionId, reason: "schema_version",
          detail: `parent file schemaVersion ${version} is not ${SESSION_FILE_SCHEMA_VERSION}`,
        }));
      return forkSession({
        parent: plane.openKernel(sessionId),
        parentSchemaVersion: version,
        openChild: () => plane.sessionStore(input.childId),
        catalog: plane.catalog,
      }, { ...input, from: sessionId });
    }),
    executor: (
      owner: string,
      clock: () => number,
      options: Parameters<typeof adoptedExecutor>[4],
    ) => adoptedExecutor(plane.openKernel(sessionId), sessionId, owner, clock, options),
    configureTools: (
      additions: readonly SessionGeneration.Tool[],
      runtime: ConfigureToolsRuntime,
    ) => configureTools(plane, sessionId, additions, runtime),
    decisions: {
      head: (key: string) => plane.sessionStore(sessionId).decisionFacts.head(key),
      record: (input: Parameters<ReturnType<LedgerPlane["sessionStore"]>["decisionFacts"]["record"]>[0]) =>
        plane.sessionStore(sessionId).decisionFacts.record(input),
    },
    transaction: <A>(operation: () => A): A => plane.sessionStore(sessionId).transaction(operation),
  };
}

function configureTools(
  plane: LedgerPlane,
  sessionId: string,
  additions: readonly SessionGeneration.Tool[],
  runtime: ConfigureToolsRuntime,
) {
  return Effect.gen(function* () {
    const kernel = plane.openKernel(sessionId);
    const row = kernel.row(sessionId);
    if (row.fenceOwner === null)
      return yield* new AgentFailure({ operation: "session.configure", cause: "authority_unavailable" });
    const before = kernel.latestGenerationFor(sessionId);
    const generation = before.generation + 1;
    const accepted = yield* runtime.authorizeConfigure({
      sessionId, role: row.role, operation: "tools.add", generation,
    });
    if (!accepted)
      return yield* new AgentFailure({ operation: "session.configure", cause: "denied" });
    const snapshot = generationSnapshot({
      generation,
      revertTo: before.generation,
      tools: [...before.tools, ...additions.map((tool) => SessionGeneration.Tool.parse(tool))],
      system: { preset: before.systemPreset, blocks: before.systemBlocks },
      policyGeneration: before.policyGeneration,
      bundles: before.bundles,
      ...(before.manifestHash === undefined ? {} : { manifestHash: before.manifestHash }),
    });
    const action = configureAction({
      id: runtime.entropy(), sessionId, parentId: kernel.latestAction(sessionId)?.id ?? null,
      operation: "tools.add", snapshot, at: runtime.clock(),
    });
    yield* runtime.generations.configure({ sessionId, generation }, snapshot,
      kernel.commit({
        sessionId, owner: row.fenceOwner, fence: row.fence,
        now: runtime.clock(), expectedRevision: row.revision, actions: [action], state: row.state,
        generation: {
          toolsGeneration: snapshot.generation, systemHash: snapshot.systemHash,
          policyGeneration: snapshot.policyGeneration,
        },
      }).pipe(Effect.mapError((error) => new CommitFailed({ error }))),
    );
    return { generation: snapshot.generation, revertTo: snapshot.revertTo };
  });
}
