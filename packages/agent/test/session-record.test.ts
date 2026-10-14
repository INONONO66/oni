import { expect, test } from "bun:test";
import { requireCommit } from "../src/testing/commit";
import { SessionCommitError } from "../src/core/ports/failure";

// A refused commit must surface the ledger's verdict verbatim: callers branch
// on `result.reason` (stale vs revision) to decide retry-versus-abort.
test("requireCommit wraps a refused commit in SessionCommitError with the verdict attached", () => {
  const refused = {
    ok: false,
    reason: "stale",
    currentFence: 4,
    currentRevision: 7,
  } as const;
  const call = () => requireCommit(refused);
  expect(call).toThrow(SessionCommitError);
  expect(call).toThrow("session commit stale");
  const error = new SessionCommitError({ result: refused });
  expect(error._tag).toBe("SessionCommitError");
  expect(error.result).toEqual(refused);
});
