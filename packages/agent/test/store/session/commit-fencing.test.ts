import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { expect, test } from "bun:test";
import type { LedgerAction, LedgerSession } from "@oni/protocol";
import { runLedgerSync } from "../helpers/effect";
import { materializeRow, residentRow } from "../helpers/ledger";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();

const sessionId = "commit-fencing";

function resultAction(id: string): LedgerAction.Append {
  return {
    id,
    parentId: null,
    sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal" } },
    effect: { encodingVersion: 1, value: { terminal: "result" } },
    irreversible: true,
    ts: 10_001,
  };
}

function commitAs(fence: number, actionId: string): LedgerSession.Commit {
  return {
    sessionId,
    owner: "kernel-owner",
    fence,
    now: 10_001,
    expectedRevision: 1,
    actions: [resultAction(actionId)],
    state: "idle",
  };
}

// C003: commit-time writer fencing. Activation A's fence is rotated away by a
// successor activation under the SAME owner name, so the fence is the only
// discriminator left. A's result commit must be REJECTED as a typed stale
// outcome atomically: no action row, no revision movement, fence untouched.
test("a stale fence is rejected at commit time with no partial row, even under the same owner name", () => {
  const { sessions } = stores.session;
  const actions = stores.session.actions;
  expect(materializeRow(sessions, residentRow(sessionId))).toBe(true);
  expect(
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(sessions.adoptFence({ sessionId, owner: "kernel-owner", fence: 1 })),
      ),
      (error) => error,
    ),
  ).toEqual({ ok: true, fence: 1 });
  // The successor activation adopts the next catalog fence under the same owner name.
  expect(
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(sessions.adoptFence({ sessionId, owner: "kernel-owner", fence: 2 })),
      ),
      (error) => error,
    ),
  ).toEqual({ ok: true, fence: 2 });
  const before = sessions.get(sessionId);
  expect(before).toMatchObject({ fenceOwner: "kernel-owner", fence: 2, revision: 1 });

  // Owner name matches and the revision is exact: only the fence is stale,
  // and the rejection is typed with the current fence.
  const rejected = () =>
    Result.getOrThrowWith(
      runLedgerSync(Effect.result(sessions.commit(commitAs(1, "stale-result")))),
      (error) => error,
    );
  expect(rejected).toThrow(
    expect.objectContaining({
      _tag: "CommitRefused",
      reason: "fence",
      currentFence: 2,
      currentRevision: 1,
    }),
  );
  expect(sessionTree(sessionId, actions).map((action) => action.id)).toEqual([
    `${sessionId}:configure`,
  ]);
  expect(sessions.get(sessionId)).toEqual(before);

  // A re-adoption of an already-passed fence is refused as stale.
  const readopt = () =>
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(sessions.adoptFence({ sessionId, owner: "other-owner", fence: 2 })),
      ),
      (error) => error,
    );
  expect(readopt).toThrow(
    expect.objectContaining({ _tag: "FenceRefused", reason: "stale", fence: 2 }),
  );

  // The successor's fence commits the identical work exactly once.
  const committed = Result.getOrThrowWith(
    runLedgerSync(Effect.result(sessions.commit(commitAs(2, "successor-result")))),
    (error) => error,
  );
  expect(committed.ok).toBe(true);
  expect(committed.row).toMatchObject({ revision: 2, fence: 2 });
  expect(sessionTree(sessionId, actions).map((action) => action.id)).toEqual([
    `${sessionId}:configure`,
    "successor-result",
  ]);
});
