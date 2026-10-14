import { sessionTree } from "./helpers/session-tree";
import { testExecutor } from "./helpers/executor";
import type { ResolvedExecutorOptions } from "../src/core/loop/executor";
import { executorLayer, catalogLayer } from "./helpers/service-layers";
import { expect, it } from "bun:test";

import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { assertFresh } from "../src/core/loop/approval";
import { ExecutionApprovalError, AgentFailure } from "../src/core/ports/failure";
import { createExecutor, } from "../src/core/loop/executor";
import { approveWriteRow, compiledPolicy } from "./helpers/compiled-policy";
import { requestLedger } from "./helpers/effect-g1";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { z } from "zod";
import { defineTool } from "../src/core/loop/tool";
import { createDispatcher } from "../src/plugins/tool";
import { bounded } from "./helpers/bounded";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

const policy = compiledPolicy([approveWriteRow]);
const evidence = { kind: "owner", principalId: "owner", evidenceId: "auth-1" } as const;
const request = {
  kind: "tool",
  op: "write",
  intent: { path: "approved.txt" },
  effect: { category: "mutation" },
  toolObservation: { turnId: "turn", callId: "call-1" },
};

function fixture(overrides: Partial<ResolvedExecutorOptions> = {}) {
  return Effect.gen(function* () {
    const opened = Promise.withResolvers<SessionTransition.Request>();
    const recording = yield* requestLedger({
      clock: overrides.clock,
      onRequest: (request) => {
        if (request.state === "open") opened.resolve(request);
      },
    });
    const executor = testExecutor({
      ...recording,
      policy,
      authorizeApproval: () => Effect.succeed(evidence),
      observations: { publish: () => undefined },
      ...overrides,
    });
    const approvals = executor.approvals;
    if (approvals === undefined) throw new Error("missing approvals");
    const executorIdentity = overrides.identity ?? recording.identity;
    const controller = new AbortController();
    const bodies: string[] = [];
    const running = yield* Effect.forkScoped(executor.runBatch(
      [
        {
          request: { ...request, op: "read" },
          body: () => Effect.sync(() => {
            bodies.push("read");
            return {};
          }),
        },
        {
          request,
          body: () => Effect.sync(() => {
            expect(isolatedLedger().kernel.requestRows(executorIdentity.sessionId)[0]?.state).toBe("resolved");
            bodies.push("write");
            return { status: "success" };
          }),
        },
        {
          request: { ...request, op: "last" },
          sequential: true,
          body: () => Effect.sync(() => {
            bodies.push("last");
            return {};
          }),
        },
      ],
      { signal: controller.signal },
    ));
    return {
      ...recording,
      ledger: overrides.ledger ?? recording.ledger,
      executor,
      controller,
      bodies,
      running,
      approvals,
      opened: Effect.promise(() => bounded(opened.promise, "durable approval request")),
    };
  });
}
for (const decision of ["approve", "refuse"] as const) {
  it(`commits authenticated ${decision} on the original invocation before opening the whole wave`, () => isolated(Effect.scoped(Effect.gen(function* () {
    const f = yield* fixture();
    const durable = yield* f.opened;
    const pending = f.approvals.pending()[0];
    if (pending === undefined) throw new Error("missing approval");
    expect(durable.inputHash).toBe(canonicalDigest(request.intent));
    expect(durable.parsedInput).toEqual(request.intent);
    expect(
      sessionTree(isolatedLedger().kernel, f.identity.sessionId).find(
        (action) => action.id === durable.requestId,
      )?.kind,
    ).toBe("tool");
    expect(f.bodies).toEqual([]);
    yield* f.approvals.answer({ request: pending, credential: "owner-token", decision });
    const results = yield* Fiber.join(f.running);
    expect(results[1]).toEqual(
      decision === "approve"
        ? { terminal: "executed", value: { status: "success" } }
        : { terminal: "blocked_pre", reason: "approval_refused" },
    );
    expect(f.bodies).toEqual(
      decision === "approve" ? ["read", "write", "last"] : ["read", "last"],
    );
    expect(
      sessionTree(isolatedLedger().kernel, f.identity.sessionId).filter(
        (action) => action.id === `${pending.id}:resolution`,
      ),
    ).toHaveLength(1);
    expect(yield* Effect.flip(
      f.approvals.answer({ request: pending, credential: "owner-token", decision }),
    )).toEqual(new ExecutionApprovalError({ code: "stale_approval" }));
  }))));
}
it("rejects forged input, changed domain facts and unavailable Owner authority", () => isolated(Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture({ authorizeApproval: undefined });
  yield* f.opened;
  const pending = f.approvals.pending()[0];
  if (pending === undefined) throw new Error("missing approval");
  expect(yield* Effect.flip(
    f.approvals.answer({
      request: { ...pending, toolsHash: "forged" },
      credential: "x",
      decision: "approve",
    }),
  )).toEqual(new ExecutionApprovalError({ code: "stale_approval" }));
  expect(yield* Effect.flip(
    f.approvals.answer({ request: pending, credential: "x", decision: "approve" }),
  )).toEqual(new ExecutionApprovalError({ code: "approval_authority_unavailable" }));
  expect(f.bodies).toEqual([]);
  f.controller.abort();
  expect(yield* Fiber.join(f.running)).toEqual([
    { terminal: "interrupted", reason: "fiber_interrupted" },
    { terminal: "blocked_pre", reason: "approval_refused" },
    { terminal: "interrupted", reason: "fiber_interrupted" },
  ]);
  expect(f.bodies).toEqual([]);
  expect(isolatedLedger().kernel.requestById(pending.id)?.state).toBe("cancelled");
}))));
it("rechecks cancellation after asynchronous authentication", () => isolated(Effect.scoped(Effect.gen(function* () {
  const authorizing = yield* Deferred.make<void>();
  const authenticated = yield* Deferred.make<typeof evidence>();
  const f = yield* fixture({
    authorizeApproval: () => Deferred.succeed(authorizing, undefined).pipe(
      Effect.andThen(Deferred.await(authenticated)),
    ),
  });
  yield* f.opened;
  const pending = f.approvals.pending()[0];
  if (pending === undefined) throw new Error("missing approval");
  const settled = yield* Effect.forkScoped(Effect.flip(
    f.approvals.answer({ request: pending, decision: "approve", credential: "x" }),
  ));
  yield* Deferred.await(authorizing).pipe(Effect.timeout("5 seconds"));
  f.controller.abort();
  yield* Fiber.join(f.running);
  yield* Deferred.succeed(authenticated, evidence);
  expect(yield* Fiber.join(settled)).toEqual(new ExecutionApprovalError({ code: "stale_approval" }));
  expect(f.bodies).toEqual([]);
}))));
it("waits for the durable deadline owner instead of registering an executor timer", () => isolated(Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture();
  const request = yield* f.opened;
  // W5.2: the alarms table is deleted; the durable deadline owner is the
  // request row itself (the timer plane fires `request.timeout` from it).
  expect(isolatedLedger().kernel.requestById(request.requestId)).toMatchObject({
    state: "open",
    deadline: request.deadline,
  });
  expect(f.approvals.pending()).toHaveLength(1);
  expect(f.bodies).toEqual([]);
  f.controller.abort();
  yield* Fiber.join(f.running);
}))));

it("expires exactly once at the deadline, even with a delayed alarm", () => isolated(Effect.scoped(Effect.gen(function* () {
  let now = 100;
  const f = yield* fixture({ clock: () => now, approvalTimeoutMs: 25 });
  const request = yield* f.opened;
  expect(f.bodies).toEqual([]);
  now = 125;
  const pending = f.approvals.pending()[0];
  if (pending === undefined) throw new Error("missing approval");
  expect(yield* Effect.flip(
    f.approvals.answer({ request: pending, credential: "x", decision: "approve" }),
  )).toEqual(new ExecutionApprovalError({ code: "stale_approval" }));
  expect(isolatedLedger().kernel.requestById(pending.id)?.state).toBe("expired");
  yield* expireApproval(f, request.requestId, now);
  expect((yield* Fiber.join(f.running))[1]).toEqual({
    terminal: "blocked_pre",
    reason: "approval_timeout",
  });
  yield* expireApproval(f, request.requestId, now);
  expect(isolatedLedger().kernel.requestById(pending.id)?.state).toBe("expired");
  expect(
    sessionTree(isolatedLedger().kernel, f.identity.sessionId).filter(
      (action) => action.id === `${pending.id}:resolution`,
    ),
  ).toHaveLength(1);
}))));
function expireApproval(f: Effect.Success<ReturnType<typeof fixture>>, requestId: string, at: number) {
  return Effect.gen(function* () {
    const transition = f.ledger.transition;
    if (transition === undefined) throw new Error("missing transition");
    const result = yield* transition(
      { kind: "request.timeout", requestId },
      `${requestId}:deadline`,
      at,
    );
    if (result.request !== undefined) f.approvals.notify?.(result.request);
  });
}

it("handles immediate expiry through the durable alarm transition", () => isolated(Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture({ approvalTimeoutMs: 0 });
  const request = yield* f.opened;
  yield* expireApproval(f, request.requestId, 100);
  expect((yield* Fiber.join(f.running))[1]).toEqual({
    terminal: "blocked_pre",
    reason: "approval_timeout",
  });
  expect(f.bodies).toEqual(["read", "last"]);
}))));
it("rejects invalid deadlines before admitting execution", () => isolated(Effect.gen(function* () {
  const recording = yield* requestLedger();
  for (const approvalTimeoutMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(yield* Effect.flip(
      createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY, ...recording, approvalTimeoutMs }).pipe(
        Effect.provide(executorLayer({
          ...recording,
          policy,
          observations: { publish: () => undefined },
        })),
      ),
    )).toMatchObject({ _tag: "AgentFailure", operation: "executor.acquire", cause: "invalid_approval_timeout" });
  }
})));

it("does not treat an uncommitted notification as approval authority", () => isolated(Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture();
  const request = yield* f.opened;
  f.approvals.notify?.({ ...request, state: "resolved", outcome: "answered" });
  expect(f.bodies).toEqual([]);
  expect(f.approvals.pending()).toHaveLength(1);
  expect(isolatedLedger().kernel.requestById(request.requestId)?.state).toBe("open");
  f.controller.abort();
  yield* Fiber.join(f.running);
  expect(f.bodies).toEqual([]);
}))));

const approvalWrite = (domain: () => number) => {
  const counter = { bodies: 0 };
  const Input = z.object({ path: z.string() });
  const tool = defineTool({
    name: "write", description: "write", category: "mutation", input: Input, output: z.string(),
    visibility: { model: ["resident"], cell: [] },
    execute: async () => { counter.bodies += 1; return "done"; },
    render: (_input: z.infer<typeof Input>, output: string) => output,
  }, (_input: z.infer<typeof Input>) => ({ required: true, domainRevisions: { domain: domain() } }));
  return { counter, tool };
};

it("the captured table retains approval binding through catalog copying and later metadata changes", () => isolated(Effect.scoped(Effect.gen(function* () {
  const opened = Promise.withResolvers<SessionTransition.Request>();
  const recording = yield* requestLedger({
    onRequest: (request: SessionTransition.Request) => { if (request.state === "open") opened.resolve(request); },
    domainRevisions: () => ({ domain: 7 }),
  });
  const executor = testExecutor({ ...recording, policy, authorizeApproval: () => Effect.succeed(evidence), observations: { publish: () => undefined } });
  const write = approvalWrite(() => 7);
  const copied = { ...write.tool };
  const dispatcher = yield* createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([copied])));
  // The table must own this binding, not re-read mutable metadata or object identity.
  copied.approval = () => ({ required: false, domainRevisions: { domain: 99 } });
  const running = yield* Effect.forkScoped(dispatcher.execute({ id: "copied-call", tool: "write", input: request.intent },
    { sessionId: recording.identity.sessionId, turnId: recording.identity.turnId }));
  const durable = yield* Effect.promise(() => bounded(opened.promise, "copied binding approval"));
  expect(durable).toMatchObject({ parsedInput: request.intent, domainRevisions: { domain: 7 } });
  expect(write.counter.bodies).toBe(0);
  const pending = executor.approvals?.pending()[0];
  if (pending === undefined || executor.approvals === undefined) return yield* Effect.die("missing copied approval");
  yield* executor.approvals.answer({ request: pending, credential: "owner-token", decision: "approve" });
  expect(yield* Fiber.join(running)).toMatchObject({ toolCallId: "copied-call", content: "done" });
  expect(write.counter.bodies).toBe(1);
}))));

it("a domain fact that moves after approval fails re-admission typed, never as a defect", () => isolated(Effect.scoped(Effect.gen(function* () {
  const opened = Promise.withResolvers<SessionTransition.Request>();
  let domain = 7;
  const recording = yield* requestLedger({
    onRequest: (request: SessionTransition.Request) => {
      if (request.state === "open") opened.resolve(request);
      if (request.state === "resolved") domain = 8;
    },
    domainRevisions: () => ({ domain: 7 }),
  });
  const executor = testExecutor({ ...recording, policy, authorizeApproval: () => Effect.succeed(evidence), observations: { publish: () => undefined } });
  const { counter, tool } = approvalWrite(() => domain);
  const dispatcher = yield* createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([tool])));
  const running = yield* Effect.forkScoped(Effect.exit(dispatcher.execute({ id: "stale-call", tool: "write", input: request.intent },
    { sessionId: recording.identity.sessionId, turnId: recording.identity.turnId })));
  yield* Effect.promise(() => bounded(opened.promise, "stale binding approval"));
  const pending = executor.approvals?.pending()[0];
  if (pending === undefined || executor.approvals === undefined) return yield* Effect.die("missing stale approval");
  yield* executor.approvals.answer({ request: pending, credential: "owner-token", decision: "approve" });
  const exit = yield* Fiber.join(running);
  expect(exit._tag === "Failure" && Cause.hasDies(exit.cause)).toBe(false);
  expect(exit._tag === "Success" ? exit.value : undefined).toMatchObject({ toolCallId: "stale-call", isError: true });
  const result = sessionTree(isolatedLedger().kernel, recording.identity.sessionId)
    .filter((action) => action.kind === "tool").at(-1);
  expect(result?.effect.value).toMatchObject({
    evidence: { failures: [{ tag: "ExecutionApprovalError", code: "stale_approval" }], defects: [] },
  });
  expect(counter.bodies).toBe(0);
}))));

it("assertFresh refuses a moved domain fact as a typed failure", () => isolated(Effect.gen(function* () {
  const exit = yield* Effect.exit(assertFresh(
    { ...request, domainRevisions: () => ({ domain: 8 }) },
    { domainRevisions: { domain: 7 } } as unknown as Parameters<typeof assertFresh>[1],
  ));
  expect(exit._tag).toBe("Failure");
  expect(exit._tag === "Failure" && Cause.hasDies(exit.cause)).toBe(false);
  expect(yield* Effect.flip(assertFresh({ ...request, domainRevisions: () => ({ domain: 8 }) },
    { domainRevisions: { domain: 7 } } as unknown as Parameters<typeof assertFresh>[1])))
    .toMatchObject({ _tag: "ExecutionApprovalError", code: "stale_approval" });
})));

it("propagates a failed deadline commit without settling the live suspension", () => isolated(Effect.scoped(Effect.gen(function* () {
  const recording = yield* requestLedger({ id: "deadline-failure" });
  const transition = recording.ledger.transition;
  if (transition === undefined) throw new Error("missing transition");
  const failure = new AgentFailure({ operation: "request.timeout", cause: "deadline storage unavailable" });
  const opened = Promise.withResolvers<SessionTransition.Request>();
  const f = yield* fixture({
    ...recording,
    approvalTimeoutMs: 0,
    ledger: {
      ...recording.ledger,
      transition: (payload, inputId, at) => Effect.gen(function* () {
        if (payload.kind === "request.timeout") return yield* failure;
        const result = yield* transition(payload, inputId, at);
        if (payload.kind === "request.open") opened.resolve(payload.request);
        return result;
      }),
    },
  });
  const request = yield* Effect.promise(() => bounded(opened.promise, "durable approval request"));
  expect(yield* Effect.flip(expireApproval(f, request.requestId, 100))).toBe(failure);
  expect(f.bodies).toEqual([]);
  expect(f.approvals.pending()).toHaveLength(1);
  expect(isolatedLedger().kernel.requestRows("deadline-failure")[0]?.state).toBe("open");
  f.controller.abort();
  yield* Fiber.join(f.running);
}))));
