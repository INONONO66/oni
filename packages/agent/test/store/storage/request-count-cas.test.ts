import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import type { LedgerSession, SessionTransition } from "@oni/protocol";
import { runLedgerSync } from "../helpers/effect";
import { adoptWriter, materializeSession } from "../helpers/session";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";
import { useSqliteStores } from "../helpers/storage";

describe("SQLite global request count CAS", () => {
  const stores = useSqliteStores("request-count-cas");

  function commitRaw(input: LedgerSession.Commit) {
    return Result.getOrThrowWith(
      runLedgerSync(Effect.result(stores.kernel.commit(input))),
      (error) => error,
    );
  }

  function proposal(request: SessionTransition.Request, count: number): LedgerSession.Commit {
    return {
      sessionId: request.sessionId,
      owner: "writer",
      fence: 1,
      now: 4,
      expectedRevision: stores.kernel.row(request.sessionId).revision,
      actions: [requestStateAction(request)],
      state: "idle",
      requestCount: { since: 0, count },
    };
  }

  test("another session opening invalidates a proposal without changing its local revision", () => {
    const { request, original, commit } = requestFixture(stores.kernel, "approval");
    expectCommitted(commit([original]));
    materializeSession(stores.kernel, "other");
    adoptWriter(stores.kernel, "other", "writer", 1);
    const other = { ...request, sessionId: "other", requestId: "other-original" };
    expectCommitted(
      commitRaw({
        ...proposal(other, 0),
        actions: [
          { ...original, id: other.requestId, sessionId: "other", parentId: "other:configure" },
        ],
      }),
    );
    const pending = proposal(request, 0);
    const before = {
      row: stores.kernel.row(request.sessionId),
      actions: sessionTree(request.sessionId, stores.session.actions),
    };
    expectCommitted(commitRaw(proposal(other, 0)));
    expect(stores.kernel.row(request.sessionId)).toEqual(before.row);
    expect(() => commitRaw(pending)).toThrow(
      expect.objectContaining({
        _tag: "CommitRefused",
        reason: "revision",
        currentFence: 1,
        currentRevision: before.row.revision,
      }),
    );
    expect(stores.kernel.row(request.sessionId)).toEqual(before.row);
    expect(sessionTree(request.sessionId, stores.session.actions)).toEqual(before.actions);
    expect(stores.kernel.requestById(request.requestId)).toBeUndefined();
    expectCommitted(commitRaw({ ...pending, requestCount: { since: 0, count: 1 } }));
  });

  test("counts latest request and reply snapshots, not historical opens or boundary entries", () => {
    const { request, original, commit } = requestFixture(stores.kernel, "approval");
    expectCommitted(commit([original, requestStateAction(request)]));
    expectCommitted(commit([requestStateAction(request, "duplicate-open")]));
    expectCommitted(commitRaw({ ...proposal(request, 1), actions: [] }));
    expectCommitted(
      commit([
        requestStateAction(
          { ...request, state: "resolved", outcome: "answered" },
          "resolved",
          "resolved",
        ),
      ]),
    );
    expectCommitted(commitRaw({ ...proposal(request, 0), actions: [] }));
    expectCommitted(commit([requestStateAction(request, "reopened")]));
    expectCommitted(
      commitRaw({
        ...proposal(request, 0),
        actions: [],
        requestCount: { since: request.createdAt, count: 0 },
      }),
    );
    expectCommitted(
      commit([requestStateAction({ ...request, mode: "answer" }, "reply-mode", "resolved")]),
    );
    expectCommitted(commitRaw({ ...proposal(request, 0), actions: [] }));
  });
});
