import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import { LedgerAction, LedgerSession, type ObservationSink } from "@openomni/protocol";
import { createActions, L0Write } from "../../../src/core/store/session-file";
import type { ObservationPublishFailure } from "../../../src/core/store/storage/sqlite-l0-observation";
import { createSessions } from "../../../src/core/store/storage/sqlite-l0-sessions";
import { runLedgerSync } from "../helpers/effect";
import { openLedgerDatabase, observedL0Adapters } from "../helpers/ledger";

const limits = { rowByteCap: L0Write.DEFAULT_ROW_BYTE_CAP };

const encoded = (value: string) => ({ encodingVersion: 1 as const, value: { value } });

function session(id: string): LedgerSession.Row {
  return LedgerSession.Row.parse({
    id,
    parentId: null,
    role: "resident",
    fenceOwner: null,
    fence: 0,
    revision: 0,
    state: "idle",
  });
}

function action(id: string, sessionId: string): LedgerAction.Append {
  return LedgerAction.Append.parse({
    id,
    parentId: null,
    sessionId,
    kind: "turn",
    intent: encoded("intent"),
    effect: encoded("result"),
    irreversible: true,
    ts: 100,
  });
}

function create(adapter: ReturnType<typeof observedL0Adapters>["adapter"], id: string) {
  Result.getOrThrowWith(
    runLedgerSync(Effect.result(adapter.sessions.create(session(id)))),
    (error) => error,
  );
}

describe("ledger-first observations", () => {
  test("publishes exactly one committed receipt after durable revision advances", () => {
    using db = openLedgerDatabase();
    const { adapter, observations, failures } = observedL0Adapters(db);
    create(adapter, "session-observed");

    const receipt = adapter.actions.append(action("action-observed", "session-observed"), 0);

    expect(receipt?.revision).toBe(1);
    expect(adapter.sessions.get("session-observed")?.revision).toBe(1);
    expect(observations).toEqual([
      { id: "action-observed", sessionId: "session-observed", revision: 1, kind: "turn" },
    ]);
    expect(failures).toEqual([]);
  });

  test("CAS refusal emits nothing", () => {
    using db = openLedgerDatabase();
    const { adapter, observations } = observedL0Adapters(db);
    create(adapter, "session-refused");

    expect(adapter.actions.append(action("action-refused", "session-refused"), 1)).toBeUndefined();
    expect(adapter.sessions.get("session-refused")?.revision).toBe(0);
    expect(sessionTree("session-refused", adapter.actions)).toEqual([]);
    expect(observations).toEqual([]);
  });

  test("throwing and noop sinks preserve the committed product result", () => {
    const throwing: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
    };
    using throwingDb = openLedgerDatabase();
    using noopDb = openLedgerDatabase();
    const routedFailures: ObservationPublishFailure[] = [];
    const throwingActions = createActions(
      throwingDb,
      (operation) => throwingDb.transaction(operation).immediate(),
      throwing,
      (failure) => routedFailures.push(failure),
      limits,
    );
    const noopFailures: ObservationPublishFailure[] = [];
    const noopActions = createActions(
      noopDb,
      (operation) => noopDb.transaction(operation).immediate(),
      { publish: () => undefined },
      (failure) => noopFailures.push(failure),
      limits,
    );
    const { adapter: throwingSessions } = observedL0Adapters(throwingDb);
    const { adapter: noopSessions } = observedL0Adapters(noopDb);
    create(throwingSessions, "session-parity");
    create(noopSessions, "session-parity");

    const withThrow = throwingActions.append(action("action-parity", "session-parity"), 0);
    const withNoop = noopActions.append(action("action-parity", "session-parity"), 0);

    expect(withThrow).toEqual(withNoop);
    expect(routedFailures).toEqual([{ actionId: "action-parity", cause: new Error("sink failed") }]);
    expect(noopFailures).toEqual([]);
    expect(sessionTree("session-parity", throwingActions)).toEqual(
      sessionTree("session-parity", noopActions),
    );
  });

  // Each row is one value a sink may throw: an Error; an object whose own
  // String() conversion throws; and a revoked Proxy, on which even `instanceof`
  // throws. Each must still reach the port as a bounded diagnostic. The port
  // counts every report and then throws itself.
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  test.each([
    ["an Error", new Error("sink failed"), "sink failed"],
    ["a value String() cannot render", { toString: 0 }, "sink threw an unrepresentable object"],
    ["a revoked Proxy", revoked.proxy, "sink threw an unrepresentable object"],
  ])(
    "a sink throwing %s and a throwing port never unwind materialize, append or a batch commit",
    (_case, thrown, message) => {
      const throwing: ObservationSink = {
        publish() {
          throw thrown;
        },
      };
      const reported: string[] = [];
      const port = (failure: ObservationPublishFailure): never => {
        reported.push(`${failure.actionId}:${failure.cause.message}`);
        throw new Error("reporter failed");
      };
      using db = openLedgerDatabase();
      const transaction = <T,>(operation: () => T): T => db.transaction(operation).immediate();
      const actions = createActions(db, transaction, throwing, port, limits);
      const sessions = createSessions(db, transaction, throwing, port, limits);

      const materialized = runLedgerSync(
        sessions.materialize({
          row: session("session-ported"),
          initialAction: { ...action("action-configured", "session-ported"), kind: "session.configure" },
        }),
      );
      expect(materialized).toMatchObject({ created: true, receipt: { revision: 1 } });
      const appended = actions.append(action("action-appended", "session-ported"), 1);
      expect(appended?.revision).toBe(2);
      runLedgerSync(sessions.adoptFence({ sessionId: "session-ported", owner: "writer", fence: 1 }));
      const committed = runLedgerSync(
        sessions.commit({
          sessionId: "session-ported",
          owner: "writer",
          fence: 1,
          now: 101,
          expectedRevision: 2,
          actions: [
            { ...action("action-first", "session-ported"), parentId: "action-appended" },
            { ...action("action-second", "session-ported"), parentId: "action-first" },
          ],
          state: "running",
        }),
      );

      expect(committed.receipts.map((receipt) => receipt.revision)).toEqual([3, 4]);
      expect(sessions.get("session-ported")?.revision).toBe(4);
      expect(sessionTree("session-ported", actions).map((node) => node.id)).toEqual([
        "action-configured",
        "action-appended",
        "action-first",
        "action-second",
      ]);
      // Every committed receipt was reported, including the second of the batch.
      expect(reported).toEqual(
        ["action-configured", "action-appended", "action-first", "action-second"].map(
          (id) => `${id}:${message}`,
        ),
      );
    },
  );
});
