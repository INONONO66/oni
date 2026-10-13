/**
 * #1348: the real-plane fork seed shared by the `session/fork-*` suites. A
 * parent is fenced and committed through `fencedSession`, then forked at a
 * named committed anchor into a separate child session file; the child store
 * is released with the enclosing scope.
 */
import { Effect, type Scope } from "effect";
import type { Delivery } from "@openomni/protocol";
import { turnTerminalAction } from "../../src/core/commit";
import { forkSession, type ForkReceipt, type ForkRefused } from "../../src/core/fork";
import type { LedgerError } from "../../src/core/store/errors";
import { openSessionStore, SESSION_FILE_SCHEMA_VERSION, type SessionStore } from "../../src/core/store/session-file";
import { sessionFileFor } from "./cluster-runtime";
import type { ClusterHome, FencedSession } from "./seeded-session";

/** One pending prompt delivery row on `sessionId`, as the Deliver door would record it. */
export function pendingPromptRow(sessionId: string, id: string, content: string, createdAt: number): Delivery.Row {
  return {
    id,
    sessionId,
    kind: "prompt",
    content,
    origin: { encodingVersion: 1, value: { source: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt,
    ordinal: 1,
  };
}

/** The `turn-1:terminal` boundary row every fork anchors at, sealing `turn-1` with a `done` result at t=3. */
export function boundaryTerminal(sessionId: string, parentId: string) {
  return turnTerminalAction({
    id: "turn-1:terminal",
    parentId,
    sessionId,
    turnId: "turn-1",
    result: { kind: "result", text: "done" },
    resumeCount: 0,
    boundaryActionId: null,
    at: 3,
  });
}

export interface ForkedChild {
  readonly receipt: ForkReceipt;
  /** The open child store; closed when the enclosing scope closes. */
  readonly child: SessionStore;
}

/** Fork `parent` at its committed action `anchorId` into a fresh child session file at `now`. */
export function forkAtAction(
  home: ClusterHome,
  parent: FencedSession,
  input: { readonly childId: string; readonly anchorId: string; readonly now?: number },
): Effect.Effect<ForkedChild, ForkRefused | LedgerError, Scope.Scope> {
  return Effect.gen(function* () {
    const anchor = parent.kernel
      .historyPage(parent.sessionId, { afterRevision: 0, limit: 50 })
      .actions.find((action) => action.id === input.anchorId);
    if (anchor === undefined) throw new Error(`${input.anchorId} anchor missing`);
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => openSessionStore(sessionFileFor(home.sessionsDir, input.childId), { now: () => 1 })),
      (store) => Effect.sync(() => store.close()),
    );
    const receipt = yield* forkSession(
      {
        parent: parent.kernel,
        parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION,
        openChild: () => child,
        catalog: parent.catalog,
      },
      {
        from: parent.sessionId,
        at: anchor.actionHash,
        childId: input.childId,
        genesisActionId: `${input.childId}:genesis`,
        now: input.now ?? 10,
      },
    );
    return { receipt, child };
  });
}
