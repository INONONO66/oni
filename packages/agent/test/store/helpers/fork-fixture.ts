import { Effect, Result } from "effect";
import { afterEach, beforeEach } from "bun:test";
import type { Delivery, LedgerAction } from "@openomni/protocol";
import { runLedgerSync } from "./effect";
import { type LedgerStores, testNow, useMemoryStores } from "./storage";
import { adoptWriter, materializeSession } from "./session";
import { openSessionStore, SESSION_FILE_SCHEMA_VERSION, type SessionStore } from "../../../src/core/store/session-file";
import { deliveryActions, receivedMessageAction } from "../../../src/core/journal/delivery";
import { turnTerminalAction } from "../../../src/core/journal/turn-rows";
import { armAction } from "../../../src/core/ports/alarm";
import { forkSession, type ForkPorts, ForkRefused, type ForkReceipt } from "../../../src/core/session/fork";
import { configureAction } from "../../../src/core/store/fence";
import type { LedgerError } from "../../../src/core/store/errors";

export const PARENT = "parent";
export const CHILD = "child";

type ChildStore = SessionStore;

/**
 * #1348: the per-test fork world every `store/*fork*`/`inspect-*` suite rides:
 * fresh in-memory parent stores plus one in-memory child session store, both
 * opened in `beforeEach` and closed in `afterEach`.
 */
export function useForkFixture() {
  const stores = useMemoryStores();
  let childStore: SessionStore | undefined;
  beforeEach(() => {
    childStore = openSessionStore(":memory:", { now: testNow });
  });
  afterEach(() => {
    childStore?.close();
    childStore = undefined;
  });
  const child = (): SessionStore => {
    if (childStore === undefined) throw new Error("child store only exists inside a test");
    return childStore;
  };
  return { stores, child, fixture: forkFixture(stores, child) };
}

/** One fork fixture (#1257) bound to a parent plane and a separate child store. */
function forkFixture(stores: LedgerStores, child: () => ChildStore) {
  function commit(
    authority: { sessionId: string; owner: string; fence: number },
    actions: readonly LedgerAction.Append[],
  ) {
    return Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          stores.kernel.commit({
            sessionId: authority.sessionId,
            owner: authority.owner,
            fence: authority.fence,
            now: 12,
            expectedRevision: stores.kernel.row(authority.sessionId).revision,
            actions: [...actions],
            state: "idle",
          }),
        ),
      ),
      (error) => error,
    );
  }

  function deliveryRow(id: string, content: string, createdAt: number): Delivery.Row {
    return {
      id,
      sessionId: PARENT,
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

  /**
   * Parent chain: genesis configure, input msg-1, its delivery into turn-1, the
   * turn terminal, an armed alarm, and a pending input msg-2.
   */
  function buildParent() {
    materializeSession(stores.kernel, PARENT);
    const authority = adoptWriter(stores.kernel, PARENT, "writer");
    const input = receivedMessageAction({
      id: "msg-1",
      sessionId: PARENT,
      kind: "prompt",
      content: "first",
      origin: { encodingVersion: 1, value: { source: "test" } },
      parentActionId: `${PARENT}:configure`,
      at: 2,
    });
    const [delivery] = deliveryActions(
      [deliveryRow("msg-1", "first", 2)],
      { kind: "turn", turnId: "turn-1" },
      "before_llm",
      input.id,
    );
    if (delivery === undefined) throw new Error("delivery action missing");
    const terminal = turnTerminalAction({
      id: "turn-1:terminal",
      parentId: delivery.id,
      sessionId: PARENT,
      turnId: "turn-1",
      result: { kind: "result", text: "done" },
      resumeCount: 0,
      boundaryActionId: null,
      at: 3,
    });
    const armed = armAction({
      parentId: terminal.id,
      sessionId: PARENT,
      purpose: "cron",
      at: 9_000,
      supersedes: null,
      alarmId: "alarm-1",
      sourceKey: "cron:alarm-1",
      payload: {},
      armSeq: 1,
      ts: 4,
    });
    const pending = receivedMessageAction({
      id: "msg-2",
      sessionId: PARENT,
      kind: "prompt",
      content: "second",
      origin: { encodingVersion: 1, value: { source: "test" } },
      parentActionId: armed.action.id,
      at: 5,
    });
    commit(authority, [input, delivery, terminal, armed.action, pending]);
    const nodes = stores.kernel.historyPage(PARENT, { afterRevision: 0, limit: 50 }).actions;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hashOf = (id: string): string => {
      const node = byId.get(id);
      if (node === undefined) throw new Error(`missing parent node ${id}`);
      return node.actionHash;
    };
    const verdict = stores.kernel.verifyChain(PARENT);
    if (verdict.kind !== "intact" || verdict.head === null)
      throw new Error("parent chain not intact");
    return { authority, hashOf, head: verdict.head, occurrenceId: armed.occurrenceId };
  }

  function ports(overrides: Partial<ForkPorts> = {}): ForkPorts {
    return {
      parent: stores.kernel,
      parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION,
      openChild: () => child(),
      catalog: stores.catalog,
      ...overrides,
    };
  }

  function fork(
    anchor: string,
    overrides: Partial<ForkPorts> = {},
    input: { childId?: string } = {},
  ): Result.Result<ForkReceipt, ForkRefused | LedgerError> {
    return runLedgerSync(
      Effect.result(
        forkSession(ports(overrides), {
          from: PARENT,
          at: anchor,
          childId: input.childId ?? CHILD,
          genesisActionId: `${input.childId ?? CHILD}:genesis`,
          now: 100,
        }),
      ),
    );
  }

  /**
   * Pins the parent generation's copy cap: a real
   * `session.configure{settings.forkCopyByteCap}` row on the parent chain,
   * exactly how the composition root's resolved value arrives.
   */
  function pinForkCap(
    authority: { sessionId: string; owner: string; fence: number },
    forkCopyByteCap: number,
  ): void {
    commit(authority, [
      configureAction({
        id: `${PARENT}:configure-cap-${forkCopyByteCap}`,
        sessionId: PARENT,
        parentId: stores.kernel.latestAction(PARENT)?.id ?? null,
        operation: "compose",
        snapshot: stores.kernel.latestGenerationFor(PARENT),
        settings: { steering: "all", followUp: "all", forkCopyByteCap },
        at: 13,
      }),
    ]);
  }

  function forked(anchor: string, overrides: Partial<ForkPorts> = {}): ForkReceipt {
    return Result.getOrThrowWith(fork(anchor, overrides), (error) => error);
  }

  function refusalOf(result: Result.Result<ForkReceipt, ForkRefused | LedgerError>): ForkRefused {
    const error = Result.isFailure(result) ? result.failure : undefined;
    if (!(error instanceof ForkRefused))
      throw new Error(`expected ForkRefused, got ${String(error)}`);
    return error;
  }

  return { commit, buildParent, ports, fork, forked, refusalOf, pinForkCap };
}
