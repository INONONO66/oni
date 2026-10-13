import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Delivery, type SessionTransition } from "@openomni/protocol";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { allowConfigure, isolatedRuntime } from "./helpers/session-services";
import { pendingRequest } from "./helpers/open-request";
import { commitSessionRequest, requestAuthorityKernel } from "../src/core/request";
import { adoptSessionAuthority } from "../src/core/run";
import { sessionTree } from "./helpers/session-tree";

/**
 * The boot request port borrows a live
 * activation's fence (`requestAuthorityKernel`), and child-session admissions
 * never ride the sender's single-session fenced batch.
 */

function runtime() {
  return { authorizeConfigure: allowConfigure, ...isolatedRuntime() };
}

/** One recorded tool invocation the request reopens (mirrors request-count-admission). */
function pending(id: string) {
  return pendingRequest(id);
}

/** Opens `request` on the sender's fenced batch with `admission` riding it. */
function openWithAdmission(
  id: string,
  request: SessionTransition.Request,
  admission: { readonly id: string; readonly sessionId: string; readonly content: string },
) {
  const kernel = isolatedLedger().kernel;
  return commitSessionRequest(
    kernel,
    id,
    { owner: `${id}:owner`, fence: 1 },
    { kind: "request.open", request },
    `${request.requestId}:open`,
    100,
    runtime(),
    Delivery.Commit.parse({
      id: admission.id,
      sessionId: admission.sessionId,
      kind: "prompt",
      content: admission.content,
      origin: { encodingVersion: 1, value: { kind: "session", sessionId: id } },
      createdAt: 100,
      parentActionId: null,
    }),
  );
}

/** The decision opened exactly this request and nothing else. */
function expectOpenedRows(
  kernel: ReturnType<typeof isolatedLedger>["kernel"],
  id: string,
  request: SessionTransition.Request,
  decision: { readonly resolution: string },
): void {
  expect(decision.resolution).toBe("opened");
  expect(kernel.requestRows(id).map((row: SessionTransition.Request) => row.requestId)).toEqual([
    request.requestId,
  ]);
}

// S1: the borrowed-fence caller's decision must run under the true live owner.
test("a borrowed-fence caller opens a request mid-turn under the live owner", () =>
  isolated(
    Effect.gen(function* () {
      const id = "borrow-live";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const liveOwner = `${id}:owner`;
      expect(kernel.row(id)).toMatchObject({ state: "running", fenceOwner: liveOwner, fence: 1 });
      const wrapped = requestAuthorityKernel(kernel, id);
      const caller = "pid:request:borrower";
      const fence = yield* adoptSessionAuthority(wrapped, id, caller);
      // Borrowing never rotates the fence or steals the row.
      expect(fence).toBe(1);
      expect(kernel.row(id)).toMatchObject({ fenceOwner: liveOwner, fence: 1 });
      const decision = yield* commitSessionRequest(
        wrapped,
        id,
        { owner: caller, fence },
        { kind: "request.open", request },
        `${request.requestId}:open`,
        100,
        runtime(),
      );
      expectOpenedRows(kernel, id, request, decision);
      // The durable row still belongs to the live activation.
      expect(kernel.row(id)).toMatchObject({ fenceOwner: liveOwner, fence: 1 });
    }),
  ));

// S1 fail-closed: authority not adopted through the borrowing view stays refused.
test("an unrelated owner is still refused mid-turn", () =>
  isolated(
    Effect.gen(function* () {
      const id = "borrow-foreign";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const before = sessionTree(kernel, id);
      const decision = yield* commitSessionRequest(
        requestAuthorityKernel(kernel, id),
        id,
        { owner: "pid:request:intruder", fence: 1 },
        { kind: "request.open", request },
        `${request.requestId}:open`,
        100,
        runtime(),
      );
      expect(decision.resolution).toBe("rejected");
      expect(decision.actions).toEqual([]);
      expect(kernel.requestRows(id)).toEqual([]);
      expect(sessionTree(kernel, id)).toEqual(before);
    }),
  ));

// S1 fallback: an idle session keeps the documented out-of-turn takeover.
test("an idle session falls back to a real fence adoption", () =>
  isolated(
    Effect.gen(function* () {
      const kernel = isolatedLedger().kernel;
      const id = "borrow-idle";
      yield* kernel.materialize({
        id,
        role: "resident",
        parentId: null,
        policyGeneration: 1,
        tools: [],
        system: { preset: "", blocks: [] },
        actionId: `${id}:configure`,
        at: 100,
      });
      const caller = "pid:request:idle-taker";
      const fence = yield* adoptSessionAuthority(requestAuthorityKernel(kernel, id), id, caller);
      expect(fence).toBe(1);
      expect(kernel.row(id)).toMatchObject({ fenceOwner: caller, fence: 1 });
    }),
  ));

// S2: a `new_session` child's admission must not ride the sender's fenced batch.
test("a foreign-session admission does not ride the sender's batch", () =>
  isolated(
    Effect.gen(function* () {
      const id = "sender-session";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const decision = yield* openWithAdmission(id, request, {
        id: "child:msg-1",
        sessionId: "child-session",
        content: "work",
      });
      // Before the fix the whole batch was refused (CommitRefused "revision").
      expectOpenedRows(kernel, id, request, decision);
      // The child's admission is not in the sender's chain: its own entity commits it.
      expect(kernel.actionById("child:msg-1")).toBeUndefined();
    }),
  ));

// S2 guard: a same-session admission still rides the fenced batch.
test("a same-session admission still rides the sender's batch", () =>
  isolated(
    Effect.gen(function* () {
      const id = "sender-local";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const decision = yield* openWithAdmission(id, request, {
        id: `${id}:msg-1`,
        sessionId: id,
        content: "local intake",
      });
      expect(decision.resolution).toBe("opened");
      const intake = kernel.actionById(`${id}:msg-1`);
      expect(intake).toMatchObject({ sessionId: id, kind: "prompt" });
    }),
  ));
