import { KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../src/core/gate/compile";
import { policySnapshot } from "./helpers/compiled-policy";
import { sessionTree as kernelSessionTree } from "./helpers/session-tree";
import { testExecutor } from "./helpers/executor";

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitRefused } from "../src/core/store/errors";

import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { z } from "zod";
import { ToolBodyFailed } from "../src/core/ports/failure";
import { executeToolBody } from "../src/core/loop/tool";
import { effectValue, fiberSessionId, nativeExecutorOptions } from "./helpers/native-executor";
import { fiberCrashCell } from "./helpers/fiber-outcome-crash";
import { isolated, isolatedLedger } from "./helpers/isolated";

/** Chain oracle over the active isolation's kernel. */
const sessionTree = (sessionId: string) => kernelSessionTree(isolatedLedger().kernel, sessionId);

const request = {
  kind: "tool", op: "write", intent: {}, effect: { category: "mutation" },
  toolObservation: { turnId: `${fiberSessionId}:turn`, callId: "write-once" },
};
function results() {
  return sessionTree(fiberSessionId).filter((action) =>
    action.kind === "tool" && effectValue(action).phase === "result").map(effectValue);
}

for (const receipt of ["absent", "present"] as const) {
  test(`SIGKILL after execute before action commit: ${receipt} receipt`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "fiber-outcome-"));
    try {
      expect(await fiberCrashCell(join(directory, "kernel.sqlite"), receipt)).toBe(
        receipt === "absent" ? "lost" : "resumed_without_reexecution",
      );
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("interrupted fiber seals one interrupted action after its entry signal", () => isolated(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const executor = testExecutor(options);
  const fiber = yield* Effect.forkChild(executor.run(request, () =>
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))));
  yield* Deferred.await(entered);
  yield* Fiber.interrupt(fiber);
  const exit = yield* Fiber.await(fiber);
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  expect(results()).toHaveLength(1);
  expect(results()).toMatchObject([{ terminal: "interrupted", evidence: { failures: [], defects: [], interrupted: true } }]);
})));

test("pre denied commits its policy node and enters zero bodies", () => isolated(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  let bodies = 0;
  const executor = testExecutor({ ...options, policy: policySnapshot({ registry: KERNEL_POLICY_REGISTRY,
    generation: 1, rows: [...SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })), {
      name: "no-write", kind: "tool", phase: "pre", generation: 1, priority: 1,
      match: { encodingVersion: 1, value: { op: "write" } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "policy" } },
    }],
  }) });
  expect(yield* executor.run(request, () => Effect.sync(() => { bodies += 1; return "no"; })))
    .toEqual({ terminal: "blocked_pre", reason: "policy" });
  expect(bodies).toBe(0);
  expect(sessionTree(fiberSessionId).filter((action) => action.kind === "tool")).toEqual([]);
  expect(sessionTree(fiberSessionId).filter((action) => action.kind === "policy.decision").map(effectValue))
    .toMatchObject([{ terminal: "blocked_pre", evidence: { failures: [{ tag: "PolicyDenied", phase: "pre" }] } }]);
})));

test("expected failures, defects and child finalizer defects have distinct serializable evidence", () => isolated(Effect.gen(function* () {
  const executor = testExecutor(yield* nativeExecutorOptions());
  yield* Effect.exit(executor.run(request, () => Effect.fail(new ToolBodyFailed({ tool: "write", cause: "EIO" }))));
  yield* Effect.exit(executor.run(request, () => Effect.die(new Error("defect-code"))));
  yield* Effect.exit(executor.run(request, () => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.die(new Error("finalizer-code")));
    return "done";
  })));
  const rows = results();
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ terminal: "executed", evidence: {
    failures: [{ tag: "ToolBodyFailed", tool: "write", cause: "EIO" }], defects: [], interrupted: false,
  } });
  expect(rows[1]).toMatchObject({ terminal: "executed", evidence: {
    failures: [], defects: [{ name: "Error", cause: "defect-code" }], interrupted: false,
  } });
  expect(rows[2]).toMatchObject({ terminal: "executed", evidence: {
    failures: [], defects: [{ name: "Error", cause: "finalizer-code" }], interrupted: false,
  } });
  expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
})));

test("terminal commit refusal publishes no success and leaves the intent open", () => isolated(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const published: string[] = [];
  const executor = testExecutor({ ...options,
    observations: { publish: (event) => { published.push(event.name); } },
    ledger: { ...options.ledger, commit: (action) =>
      action.kind === "tool" && effectValue(action).phase === "result"
        ? Effect.fail(new CommitRefused({ sessionId: fiberSessionId, reason: "fence", expectedRevision: 0,
            currentRevision: 1, fence: 1, currentFence: 2 }))
        : options.ledger.commit(action),
    },
  });
  const exit = yield* Effect.result(executor.run(request, () => Effect.succeed({ status: "success" })));
  expect(exit).toMatchObject({ _tag: "Failure", failure: { _tag: "CommitFailed", error: { _tag: "CommitRefused", reason: "fence" } } });
  expect(results()).toEqual([]);
  expect(published).not.toContain("tool.execution.completed");
  expect(sessionTree(fiberSessionId).filter((action) => action.kind === "tool")).toHaveLength(1);
})));

test("ignored raw abort fixes outcome_unknown without awaiting raw settlement or releasing escrow", () => isolated(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const released = Promise.withResolvers<string>();
  const retained: Promise<void>[] = [];
  const executor = testExecutor({ ...options, closeGraceMs: 0, retainEffect: (slot) => retained.push(slot) });
  const definition = {
    name: "write", description: "write", category: "mutation" as const,
    input: z.object({}), output: z.string(), visibility: { model: [] as const, cell: [] as const },
    execute: async () => {
      Deferred.doneUnsafe(entered, Exit.void);
      return released.promise;
    }, render: (_input: object, output: string) => output,
  };
  const fiber = yield* Effect.forkChild(executor.run(request, () => executeToolBody(definition, {}, {
    sessionId: fiberSessionId, turnId: `${fiberSessionId}:turn`, callId: "write-once", signal: new AbortController().signal,
  }, undefined)));
  yield* Deferred.await(entered);
  expect(retained).toHaveLength(1);
  yield* Fiber.interrupt(fiber);
  expect(results()).toMatchObject([{ terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" }]);
  const before = results();
  released.resolve("late");
  yield* Effect.promise(() => Promise.all(retained));
  expect(results()).toEqual(before);
})));
