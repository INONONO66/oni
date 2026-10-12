import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { Database } from "bun:sqlite";
import type { LedgerSession, ObservationSink } from "@openomni/protocol";
import { Context, type Crypto, Data, Duration, Effect, Layer, type Scope } from "effect";
import { SingleRunner } from "effect/cluster";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AlarmDrainConfig } from "./alarm";
import {
  createSessionEntityLayer,
  createSessionEntityRunTurn,
  SessionEntityContext,
} from "./entity";
import type { ResolvedSessionRuntime, SessionEntityPorts, SessionRunner } from "./run";
import { type CatalogStore, openCatalogStore } from "./store/catalog";
import * as SessionHandleStore from "./store/fence";
import type { LedgerHandles } from "./store/services";
import { openSessionStore, type SessionStore } from "./store/session-file";
import type { ObservationFailurePort } from "./store/storage/sqlite-l0-observation";

/** The cluster's entity reaper never scans more often than five seconds. */
const ENTITY_REAPER_INTERVAL_MS = 5_000;

type SessionKernel = SessionHandleStore.SessionKernel;

/** Per-session ledger file path: the one place the layout is spelled. */
export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.sqlite`);
}

export interface LedgerStoreConfig {
  /** Injected wall clock: the store plane never reads ambient time. */
  readonly now: () => number;
  /** Catalog SQLite file; absent = an in-memory catalog. */
  readonly catalog?: { readonly path?: string };
  /**
   * Directory of per-session ledger files. Absent, session stores are
   * memoized in-memory handles shared between the plane and the entity.
   */
  readonly sessions?: { readonly dir?: string };
  readonly observationSink?: ObservationSink;
  /** Where a post-commit observation publish failure is reported; absent drops it. */
  readonly onObservationFailure?: ObservationFailurePort;
}

/** The ledger plane: one catalog handle, memoized per-session kernels and the entity's turn port. */
export interface LedgerPlane {
  readonly catalog: CatalogStore;
  /** The catalog's raw SQLite handle for stores that ride the same file. */
  readonly catalogDatabase: Database;
  readonly handles: LedgerHandles;
  openKernel(sessionId: string): SessionKernel;
  sessionStore(sessionId: string): SessionStore;
  /** Durable sessions this process can open: session files merged with opened handles. */
  listSessions(): LedgerSession.Row[];
  turnPort(
    runner: SessionRunner,
    runtime: ResolvedSessionRuntime,
    scope: Scope.Scope,
  ): SessionEntityPorts["runTurn"];
  close(): void;
}

export class Ledger extends Context.Service<Ledger, LedgerPlane>()("@openomni/agent/core/Ledger") {}

export class OpenRefused extends Data.TaggedError("OpenRefused")<{
  readonly code: "catalog" | "sessions";
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `ledger open refused (${this.code}): ${this.path}`;
  }
}

export interface LedgerConfig extends LedgerStoreConfig {
  /** Writer identity stamped into `lease_owner` (audit only; the fence authorizes). */
  readonly owner: string;
  readonly cluster: {
    /** SQLite file holding the runner and message tables; `:memory:` isolates a process. */
    readonly storagePath: string;
    readonly entityIdleMs: number;
  };
  /** Loop consumption values and the entity ports; a late-bound slot's `ready` holds activations. */
  readonly drain: AlarmDrainConfig;
  readonly ports: SessionEntityPorts;
}

/** Services the host contributes beyond `Ledger` (entity client access). */
export type ClusterServices = Layer.Success<ReturnType<typeof SingleRunner.layer>>;

/** The plane synchronously, without the host; the caller owns `close` (hermetic fixtures). */
export function openLedgerPlane(config: LedgerStoreConfig): LedgerPlane {
  const sessionsDir = config.sessions?.dir;
  if (sessionsDir !== undefined) mkdirSync(sessionsDir, { recursive: true });
  const catalog = openCatalogStore(config.catalog?.path ?? ":memory:", {
    now: config.now,
    ...(config.observationSink === undefined ? {} : { observationSink: config.observationSink }),
  });
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
  const memo = new Map<string, { store: SessionStore; kernel: SessionKernel }>();
  function opened(sessionId: string) {
    let entry = memo.get(sessionId);
    if (entry === undefined) {
      const store = openSessionStore(
        sessionsDir === undefined ? ":memory:" : sessionFilePath(sessionsDir, sessionId),
        sessionOptions,
      );
      entry = { store, kernel: SessionHandleStore.createSessionKernel(store, catalog) };
      memo.set(sessionId, entry);
    }
    return entry;
  }
  function sessionIds(): string[] {
    const ids = new Set(memo.keys());
    if (sessionsDir !== undefined && existsSync(sessionsDir)) {
      for (const file of readdirSync(sessionsDir)) {
        if (file.endsWith(".sqlite")) ids.add(file.slice(0, -".sqlite".length));
      }
    }
    return [...ids];
  }
  return {
    catalog,
    catalogDatabase: catalog.database,
    handles: {
      catalog,
      // File mode: fresh handles the entity closes on passivation; in-memory: shared.
      openSession: (sessionId) =>
        sessionsDir === undefined
          ? opened(sessionId).store
          : openSessionStore(sessionFilePath(sessionsDir, sessionId), sessionOptions),
    },
    openKernel: (sessionId) => opened(sessionId).kernel,
    sessionStore: (sessionId) => opened(sessionId).store,
    listSessions: () =>
      sessionIds().flatMap((id) => {
        try {
          return [opened(id).kernel.row(id)];
        } catch {
          return [];
        }
      }),
    turnPort: createSessionEntityRunTurn,
    close: () => {
      for (const entry of memo.values()) entry.store.close();
      memo.clear();
      catalog.close();
    },
  };
}

/** The store plane under a Scope: the catalog is acquired first so a later refusal releases it. */
function ledgerLayer(config: LedgerConfig): Layer.Layer<Ledger, OpenRefused> {
  const catalogPath = config.catalog?.path ?? ":memory:";
  return Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const catalog = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            openCatalogStore(catalogPath, {
              now: config.now,
              ...(config.observationSink === undefined
                ? {}
                : { observationSink: config.observationSink }),
            }),
          catch: (cause) => new OpenRefused({ code: "catalog", path: catalogPath, cause }),
        }),
        (opened) => Effect.sync(() => opened.close()),
      );
      const sessionsDir = config.sessions?.dir;
      if (sessionsDir !== undefined) {
        yield* Effect.try({
          try: () => mkdirSync(sessionsDir, { recursive: true }),
          catch: (cause) => new OpenRefused({ code: "sessions", path: sessionsDir, cause }),
        });
      }
      const plane = planeOver(catalog, sessionsDir, config);
      yield* Effect.addFinalizer(() => Effect.sync(() => plane.close()));
      return plane;
    }),
  );
}

/**
 * The one host: catalog, session opener, SQLite client, single-node runner and
 * the Session entity acquired under one Scope and released once, in reverse.
 * Sharding config is pinned explicit; ambient `SHARDING_*` env never applies.
 */
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
    Effect.map(Ledger, (plane) => ({
      owner: config.owner,
      clock: config.now,
      catalog: plane.catalog,
      openSession: plane.handles.openSession,
      ports: config.ports,
    })),
  );
  return createSessionEntityLayer(config.drain).pipe(
    Layer.provide(env),
    Layer.provideMerge(runner),
    Layer.provideMerge(ledgerLayer(config)),
  );
}
