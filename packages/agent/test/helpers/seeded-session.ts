/**
 * #1348: the one durable-handle fixture every cluster-backed suite seeds
 * through. A cluster home (`clusterTempDir`) stays the hosting layer; this
 * module only owns the repeated "open catalog + session file, bind a kernel,
 * materialize + index, adopt a fence, close" setup so each test acquires
 * fresh real SQLite handles and closes them on every exit.
 */
import { Effect, type Scope } from "effect";
import type { LedgerSession } from "@oni/protocol";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import type { CommitReceipt } from "../../src/core/store/services";
import type { LedgerError } from "../../src/core/store/errors";
import { sessionFileFor } from "./cluster-runtime";

/** The two durable locations of one cluster home. */
export interface ClusterHome {
  readonly sessionsDir: string;
  readonly catalogFile: string;
}

export interface SessionHandles {
  readonly catalog: ReturnType<typeof openCatalogStore>;
  readonly store: ReturnType<typeof openSessionStore>;
  readonly kernel: SessionHandleStore.SessionKernel;
  /** Closes the session file first, then the catalog. */
  readonly close: () => void;
}

const fixedClock = () => 1;

/** Open the catalog and one session file and bind a kernel; the caller closes. */
function openSessionHandles(
  home: ClusterHome,
  sessionId: string,
  now: () => number = fixedClock,
): SessionHandles {
  const catalog = openCatalogStore(home.catalogFile, { now });
  const store = openSessionStore(sessionFileFor(home.sessionsDir, sessionId), { now });
  return {
    catalog,
    store,
    kernel: SessionHandleStore.createSessionKernel(store, catalog),
    close: () => {
      store.close();
      catalog.close();
    },
  };
}

/** Fresh handles around one synchronous read or write, closed on every exit. */
export function withSessionHandles<A>(
  home: ClusterHome,
  sessionId: string,
  use: (handles: SessionHandles) => A,
  now?: () => number,
): A {
  const handles = openSessionHandles(home, sessionId, now);
  try {
    return use(handles);
  } finally {
    handles.close();
  }
}

/** Fresh handles acquired in the caller's Scope and closed when it closes. */
export function sessionHandles(
  home: ClusterHome,
  sessionId: string,
  now?: () => number,
): Effect.Effect<SessionHandles, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => openSessionHandles(home, sessionId, now)),
    (handles) => Effect.sync(handles.close),
  );
}

/** Materialize one resident session and index it in the catalog (the canonical seed). */
export function materializeSession(
  handles: Pick<SessionHandles, "catalog" | "kernel">,
  sessionId: string,
  at = 1,
  /** `index: false` leaves the session file unindexed (the self-heal probes). */
  options: { readonly index?: boolean } = {},
): Effect.Effect<void, LedgerError> {
  return handles.kernel
    .materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at,
    })
    .pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (options.index === false) return;
          handles.catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: at });
        }),
      ),
    );
}

type CommitActions = LedgerSession.Commit["actions"];

export interface FencedSession extends SessionHandles {
  readonly sessionId: string;
  readonly owner: string;
  readonly fence: number;
  /** One fenced commit at the live row's revision and state. */
  readonly commit: (actions: CommitActions, now?: number) => Effect.Effect<CommitReceipt, LedgerError>;
}

/**
 * Materialize + index, then rotate and adopt the catalog fence under `owner`:
 * the seeded world a test commits arbitrary rows into before a cluster boots.
 * Acquired in the caller's Scope; both handles close with it.
 */
export function fencedSession(
  home: ClusterHome,
  sessionId: string,
  options: {
    readonly owner?: string;
    /** Adopt this exact fence instead of rotating the catalog's (a pre-crash world). */
    readonly fence?: number;
    readonly now?: () => number;
    readonly commitNow?: () => number;
  } = {},
): Effect.Effect<FencedSession, LedgerError, Scope.Scope> {
  const owner = options.owner ?? "seeder";
  const commitNow = options.commitNow ?? fixedClock;
  return Effect.gen(function* () {
    const handles = yield* sessionHandles(home, sessionId, options.now);
    yield* materializeSession(handles, sessionId);
    const fence = options.fence ?? handles.catalog.rotateFence(sessionId);
    yield* handles.kernel.adoptFence({ sessionId, owner, fence });
    const commit = (actions: CommitActions, now: number = commitNow()) => {
      const row = handles.kernel.row(sessionId);
      return handles.kernel.commit({
        sessionId,
        owner,
        fence,
        now,
        expectedRevision: row.revision,
        actions,
        state: row.state,
      });
    };
    return { ...handles, sessionId, owner, fence, commit };
  });
}

/** The durable armed-alarm index of one session through fresh read handles. */
export function readArmedAlarms(home: ClusterHome, sessionId: string) {
  return withSessionHandles(home, sessionId, ({ kernel }) => kernel.armedAlarms());
}
