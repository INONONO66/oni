import { sessionTree } from "./helpers/session-tree";
import { Effect } from "effect";
import { expect, spyOn, test } from "bun:test";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { allowConfigure, isolatedRuntime } from "./helpers/session-services";
import { pendingRequest } from "./helpers/open-request";
import type { SessionTransition } from "@oni/protocol";
import { commitSessionRequest } from "../src/core/session/request";


function pending(id: string) {
  return pendingRequest(id);
}

function open(request: SessionTransition.Request) {
  return commitSessionRequest(
    isolatedLedger().kernel,
    request.sessionId,
    { owner: `${request.sessionId}:owner`, fence: 1 },
    { kind: "request.open", request },
    `${request.requestId}:open`,
    100,
    { authorizeConfigure: allowConfigure, ...isolatedRuntime() },
  );
}

test("sessionOpenApprovalCount: admission carries the per-session-file count into the real SQLite transaction; both sessions share this one store", () =>
  isolated(
    Effect.gen(function* () {
      const first = yield* pending("first");
      const second = yield* pending("second");
      const kernel = isolatedLedger().kernel;
      const sessions = isolatedLedger().session.sessions;
      const commit = sessions.commit;
      let interleaved = false;
      const intercepted = spyOn(sessions, "commit").mockImplementation(
        (input: Parameters<typeof commit>[0]) =>
          Effect.gen(function* () {
            if (input.sessionId === first.sessionId && !interleaved) {
              interleaved = true;
              expect((yield* open(second).pipe(Effect.orDie)).resolution).toBe("opened");
            }
            return yield* commit(input);
          }),
      );
      try {
        const before = kernel.row(first.sessionId);
        const actions = sessionTree(kernel, first.sessionId);
        expect(yield* Effect.flip(open(first))).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "CommitRefused" },
        });
        expect(kernel.row(first.sessionId)).toEqual(before);
        expect(sessionTree(kernel, first.sessionId)).toEqual(actions);
        expect(
          kernel.requestRows().map(
            (request: SessionTransition.Request) => request.requestId,
          ),
        ).toEqual([second.requestId]);
        expect(yield* open(first)).toMatchObject({
          resolution: "opened",
          requestCount: { since: 100 - 3_600_000, count: 1 },
        });
      } finally {
        intercepted.mockRestore();
      }
    }),
  ));
