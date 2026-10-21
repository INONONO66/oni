import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import type { LedgerAction } from "@oni/protocol";
import type { LedgerError } from "../../../src/core/store/errors";
import { runLedgerSync } from "../helpers/effect";
import { materializeRow, residentRow } from "../helpers/ledger";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();

function run<T>(effect: Effect.Effect<T, LedgerError>): T {
  return Result.getOrThrowWith(runLedgerSync(Effect.result(effect)), (error) => error);
}

const l0Session = residentRow;

function terminalAction(sessionId: string): LedgerAction.Append {
  return {
    id: `${sessionId}:result`,
    parentId: null,
    sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal" } },
    effect: { encodingVersion: 1, value: { terminal: "result" } },
    irreversible: true,
    ts: 30_001,
  };
}

function promptAction(
  sessionId: string,
  id: string,
  content: string,
  ts: number,
): LedgerAction.Append {
  return {
    id,
    parentId: null,
    sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: { source: "test" } },
    effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content } },
    irreversible: true,
    ts,
  };
}

describe("fenced session write discipline", () => {
  test("SQLite rejects a stale fence after a successor adoption under another owner", () => {
    const { sessions } = stores.session;
    const sessionId = "session-fence";
    expect(materializeRow(sessions, l0Session(sessionId))).toBe(true);

    expect(run(sessions.adoptFence({ sessionId, owner: "owner-a", fence: 1 }))).toEqual({
      ok: true,
      fence: 1,
    });
    // A rival on a fence the file already passed is refused as stale.
    expect(() => run(sessions.adoptFence({ sessionId, owner: "owner-b", fence: 1 }))).toThrow(
      expect.objectContaining({ _tag: "FenceRefused", reason: "stale", fence: 1 }),
    );
    expect(run(sessions.adoptFence({ sessionId, owner: "owner-b", fence: 2 }))).toEqual({
      ok: true,
      fence: 2,
    });

    const committed = run(
      sessions.commit({
        sessionId,
        owner: "owner-b",
        fence: 2,
        now: 30_001,
        expectedRevision: 1,
        actions: [terminalAction(sessionId)],
        state: "idle",
      }),
    );
    expect(committed.ok).toBe(true);
    expect(committed.row).toMatchObject({ revision: 2, fence: 2, fenceOwner: "owner-b" });

    expect(() =>
      run(
        sessions.commit({
          sessionId,
          owner: "owner-a",
          fence: 1,
          now: 30_001,
          expectedRevision: 1,
          actions: [{ ...terminalAction(sessionId), id: `${sessionId}:late-result` }],
          state: "idle",
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        _tag: "CommitRefused",
        reason: "fence",
        currentFence: 2,
        currentRevision: 2,
      }),
    );
  });

  test("SQLite consumes one ordered boundary batch with its actions", () => {
    const { sessions } = stores.session;
    const kernel = stores.kernel;
    const sessionId = "session-boundary";
    expect(materializeRow(sessions, l0Session(sessionId))).toBe(true);
    expect(run(sessions.adoptFence({ sessionId, owner: "owner", fence: 1 }))).toEqual({
      ok: true,
      fence: 1,
    });

    const prompts = [
      promptAction(sessionId, `${sessionId}:prompt-1`, "first", 10),
      promptAction(sessionId, `${sessionId}:prompt-2`, "second", 11),
    ];
    expect(
      run(
        sessions.commit({
          sessionId,
          owner: "owner",
          fence: 1,
          now: 11,
          expectedRevision: 1,
          actions: prompts,
          state: "idle",
        }),
      ).ok,
    ).toBe(true);
    expect(kernel.pendingMessages(sessionId).map((row) => [row.id, row.status])).toEqual([
      [`${sessionId}:prompt-1`, "pending"],
      [`${sessionId}:prompt-2`, "pending"],
    ]);

    const actions = prompts.map(
      (row, index): LedgerAction.Append => ({
        id: `${row.id}:delivery`,
        parentId: index === 0 ? null : `${prompts[index - 1]?.id}:delivery`,
        sessionId,
        kind: "prompt",
        intent: { encodingVersion: 1, value: { deliveryId: row.id } },
        effect: { encodingVersion: 1, value: { content: row.id } },
        irreversible: true,
        ts: 12,
      }),
    );
    actions.push({
      id: `${sessionId}:turn`,
      parentId: actions.at(-1)?.id ?? null,
      sessionId,
      kind: "turn",
      intent: { encodingVersion: 1, value: { phase: "intent" } },
      effect: { encodingVersion: 1, value: { resultId: `${sessionId}:result` } },
      irreversible: true,
      ts: 12,
    });

    const committed = run(
      sessions.commit({
        sessionId,
        owner: "owner",
        fence: 1,
        now: 12,
        expectedRevision: 3,
        actions,
        state: "running",
      }),
    );
    expect(committed.ok).toBe(true);
    expect(committed.row).toMatchObject({ revision: 6, state: "running", fenceOwner: "owner" });
    expect(kernel.pendingMessages(sessionId)).toEqual([]);
  });
});

describe("canonical batch rollback", () => {
  test("a refused later action rolls back earlier actions, revision and pending projection", () => {
    const { sessions } = stores.session;
    const kernel = stores.kernel;
    const sessionId = "rollback";
    expect(materializeRow(sessions, l0Session(sessionId))).toBe(true);
    run(sessions.adoptFence({ sessionId, owner: "owner", fence: 1 }));
    run(
      sessions.commit({
        sessionId,
        owner: "owner",
        fence: 1,
        now: 1,
        expectedRevision: 1,
        actions: [promptAction(sessionId, `${sessionId}:input`, "preserve", 1)],
        state: "idle",
      }),
    );
    const before = sessions.get(sessionId);
    const pending = kernel.pendingMessages(sessionId);
    expect(pending).toHaveLength(1);
    const first = { ...terminalAction(sessionId), ts: 3 };
    const refused = { ...first, id: `${sessionId}:refused`, parentId: "missing-parent" };
    expect(() =>
      run(
        sessions.commit({
          sessionId,
          owner: "owner",
          fence: 1,
          now: 3,
          expectedRevision: 2,
          actions: [first, refused],
          state: "idle",
        }),
      ),
    ).toThrow(expect.objectContaining({ _tag: "CommitRefused", reason: "revision" }));
    expect(sessions.get(sessionId)).toEqual(before);
    expect(kernel.pendingMessages(sessionId)).toEqual(pending);
  });
});
