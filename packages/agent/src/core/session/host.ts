import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { Database } from "bun:sqlite";
import type { LedgerSession, ObservationSink } from "@openomni/protocol";
import { Context, type Crypto, Data, Duration, Effect, Layer, type Scope } from "effect";
import { SingleRunner } from "effect/cluster";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AlarmDrainConfig } from "../ports/alarm";
import {
  createSessionEntityLayer,
  createSessionEntityRunTurn,
  SessionEntityContext,
} from "./entity";
import { thrownAsError } from "../ports/failure";
import type { ResolvedSessionRuntime, SessionEntityPorts, SessionRunner } from "./run";
import { type CatalogStore, openCatalogStore } from "../store/catalog";
import * as SessionHandleStore from "../store/fence";
import type { LedgerHandles } from "../store/services";
import { openSessionStore, type SessionStore } from "../store/session-file";
import type { ObservationFailurePort } from "../store/storage/sqlite-l0-observation";
import { sessionIdProblem } from "./session-id";

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
  readonly catalog: CatalogStore;
  readonly catalogDatabase: Database;
  readonly handles: LedgerHandles;
  /** Both valid until the session's next passivation closes them: resolve per use, never hold across an await. */
  openKernel(sessionId: string): SessionKernel;
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

export class Ledger extends Context.Service<Ledger, LedgerPlane>()("@openomni/agent/core/Ledger") {}

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
    sessionStore: (sessionId) => opened(sessionId).store,
    releaseSession,
    discardSession: (sessionId) => {
      const entry = memo.get(sessionId);
      if (entry?.newFile !== true || entry.store.sessions.get(sessionId) !== undefined) return;
      releaseSession(sessionId);
      if (sessionsDir !== undefined) rmSync(sessionFilePath(sessionsDir, sessionId));
    },
    listSessions: () => {
      if (sessionsDir === undefined)
        return [...memo]
          .filter(([id, entry]) => entry.store.sessions.get(id) !== undefined)
          .map(([id, entry]) => entry.kernel.row(id));
      const liveIds = [...memo].filter(([id, entry]) => entry.store.sessions.get(id) !== undefined).map(([id]) => id);
      return [...new Set([...catalog.sessionIds(), ...liveIds])].flatMap((id) => {
        // A second handle's bootstrap would wait on a write transaction held through the memo.
        const live = memo.get(id);
        const path = sessionFilePath(sessionsDir, id);
        // An index row without a file was never created: skipped, unlike a file that will not open.
        if (live === undefined && !existsSync(path)) return [];
        try {
          if (live !== undefined) return [live.kernel.row(id)];
          const store = openSessionStore(path, sessionOptions);
          try {
            return [SessionHandleStore.createSessionKernel(store, catalog).row(id)];
          } finally {
            store.close();
          }
        } catch (cause) {
          throw refused("sessions", path, cause);
        }
      });
    },
    turnPort: createSessionEntityRunTurn,
    close: () => {
      for (const entry of memo.values()) entry.store.close();
      memo.clear();
      catalog.close();
    },
  };
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
