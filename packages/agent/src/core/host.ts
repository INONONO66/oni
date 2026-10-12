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
import { thrownAsError } from "./failure";
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
  /** Per-session ledger file directory; absent = memoized in-memory stores shared with the entity. */
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
  readonly cause: Error;
}> {
  /** A store-opening throw as the typed refusal: the cause rides as an Error. */
  static fromThrown<E>(code: OpenRefused["code"], path: string, cause: E): OpenRefused {
    return new OpenRefused({ code, path, cause: thrownAsError(cause) });
  }

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

/**
 * The one store opener: the catalog first, then the sessions directory, so a
 * sessions refusal releases the catalog it just opened. Throws `OpenRefused`.
 * The caller owns `close`; `ledgerLayer` is the scoped caller and
 * `Testing.openLedgerPlane` the only other one (hermetic fixtures).
 */
export function openLedgerPlane(config: LedgerStoreConfig): LedgerPlane {
  const catalogPath = config.catalog?.path ?? ":memory:";
  let catalog: CatalogStore;
  try {
    catalog = openCatalogStore(catalogPath, {
      now: config.now,
      ...(config.observationSink === undefined ? {} : { observationSink: config.observationSink }),
    });
  } catch (cause) {
    throw OpenRefused.fromThrown("catalog", catalogPath, cause);
  }
  const sessionsDir = config.sessions?.dir;
  if (sessionsDir !== undefined) {
    try {
      mkdirSync(sessionsDir, { recursive: true });
    } catch (cause) {
      catalog.close();
      throw OpenRefused.fromThrown("sessions", sessionsDir, cause);
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
      // File mode: a fresh handle the entity closes on passivation. In-memory:
      // the plane's memoized store, retained so a successor continues the chain.
      openSession: (sessionId) =>
        sessionsDir === undefined
          ? retained(opened(sessionId).store)
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

/** A view of the plane's own store whose `close` is a no-op: the plane closes the store, never the entity. */
function retained(store: SessionStore): SessionStore {
  const view: SessionStore = Object.create(store, { close: { value: () => undefined } });
  return view;
}

/**
 * The store plane under a Scope: `openLedgerPlane` is the one opener and the
 * plane's `close` the one release, so the catalog closes exactly once. A
 * typed refusal fails the layer; any other throw is a defect of the opener.
 */
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
