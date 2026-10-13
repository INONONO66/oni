import { sessionTree } from "../../helpers/session-tree";
import { testExecutor } from "../../helpers/executor";
import type { ResolvedExecutorOptions } from "../../../src/core/gate/decide";
import { Cause, Effect, Exit, Fiber } from "effect";
import { isolated, isolatedLedger } from "../../helpers/isolated";
import { expect, test } from "bun:test";
import { requestLedger, turnExecutor, failure } from "../../helpers/effect-g1";
import { AgentFailure } from "../../../src/core/failure";
import { LlmRunFailure } from "../../../src/core/llm";
import { fakeClassifyFailure, FakeProviderError } from "../../helpers/fake-llm";
import { runChatAttempts } from "../../helpers/effect-g1";
import { compiledPolicy } from "../../helpers/compiled-policy";
import { LedgerAction, type PlainObject, type PlainValue, type SessionTransition } from "@openomni/protocol";

const usage = {
  inputTokens: 17,
  outputTokens: 2,
  reasoningTokens: 1,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
};
function providerFailure(visibleOutput = false) {
  return new LlmRunFailure({
      message: "overloaded",
      aborted: false,
      contextOverflow: false,
      visibleOutput,
      usage,
      retryAfterMs: 0,
      cause: new FakeProviderError({
        message: "overloaded", statusCode: 529, responseHeaders: { "retry-after-ms": "0" }, isRetryable: true,
        failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false },
      }),
  });
}

function harness(overrides: Partial<ResolvedExecutorOptions> = {}) {
  const waits: number[] = [];
  return {
    ...turnExecutor(compiledPolicy(), undefined, {
      retryAlarm: {
        arm: () => Effect.void,
        // turnExecutor pins clock() === 1, so fireAt - 1 is the scheduled delay.
        wait: (fireAt: number) => Effect.sync(() => { waits.push(fireAt - 1); }),
        settle: () => Effect.void,
      },
      ...overrides,
    }),
    waits,
  };
}
function effectRecord(action: LedgerAction.Append): PlainObject {
  const value = action.effect.value;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

/** The attempt result rows whose recorded terminal is `terminal`. */
function attemptResults(actions: readonly LedgerAction.Append[], terminal: string) {
  return actions.filter((a: LedgerAction.Append) => a.kind === "llm" && effectRecord(a).terminal === terminal);
}

/**
 * Logical llm actions and physical attempts share the `llm` kind; an
 * attempt intent is the row that pins its attempt ordinal in the intent.
 */
function intents(actions: readonly LedgerAction.Append[], which: "logical" | "attempt") {
  return actions.filter(
    (a: LedgerAction.Append) =>
      a.kind === "llm" &&
      typeof a.intent.value === "object" &&
      a.intent.value !== null &&
      !Array.isArray(a.intent.value) &&
      a.intent.value.phase === "intent" &&
      (which === "attempt") === (typeof a.intent.value.attempt === "number"),
  );
}

test("executor admits ordered retry children and retains every failed billed usage", () => isolated(Effect.scoped(Effect.gen(function* () {
  const { executor, committed, waits } = harness();
  const admissions: number[] = [];
  let calls = 0;
  const result = yield* executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent: LedgerAction.Receipt) =>
    executor.runAttempts(parent, {
      classify: (error) => fakeClassifyFailure({ error }),
      prepare: (attempt: number) => Effect.succeed({
        request: { op: "chat", intent: { attempt }, effect: {} },
        admit: () => Effect.sync(() => { admissions.push(attempt); }),
        body: () => Effect.gen(function* () {
          calls += 1;
          if (calls < 3) return yield* providerFailure();
          return { type: "stop" };
        }),
      }),
    }),
  );
  expect(result).toMatchObject({ terminal: "executed", value: { type: "stop" } });
  expect(admissions).toEqual([1, 2, 3]);
  expect(waits).toEqual([0, 0]);
  const parents = intents(committed, "logical");
  const attempts = intents(committed, "attempt");
  expect(parents).toHaveLength(1);
  expect(attempts.map((a: LedgerAction.Append) => a.parentId)).toEqual(new Array(3).fill(parents[0]?.id));
  const failed = attemptResults(committed, "executed").filter((action: LedgerAction.Append) => {
    const evidence = effectRecord(action).evidence;
    return evidence !== null && typeof evidence === "object" && !Array.isArray(evidence) && Array.isArray(evidence.failures);
  });
  expect(failed).toHaveLength(2);
  for (const result of failed) expect(result.effect.value).toMatchObject({ evidence: { failures: [{ tag: "LlmRunFailure", usage }] } });
  expect(
    committed.filter(
      (a: LedgerAction.Append) =>
        a.kind === "policy.decision" &&
        typeof a.intent.value === "object" &&
        a.intent.value !== null &&
        !Array.isArray(a.intent.value) &&
        a.intent.value.hook === "llm.pre",
    ),
  ).toHaveLength(3);
}))));

test("every attempt pins its ordinal, cap and retry reason; the settled one pins projected evidence", () => isolated(Effect.scoped(Effect.gen(function* () {
  const { executor, committed } = harness();
  let calls = 0;
  const evidence = { usage, visibleOutput: true, credential: { type: "api", fingerprint: "ab12" } };
  yield* runChatAttempts(
    executor,
    () => Effect.gen(function* () {
      calls += 1;
      if (calls < 2) return yield* providerFailure();
      return { type: "stop", evidence };
    }),
    (value: PlainValue) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value.evidence ?? null)
        : null,
  );
  expect(intents(committed, "attempt").map((a: LedgerAction.Append) => a.intent.value)).toMatchObject([
    { attempt: 1, maxAttempts: 3, retryReason: null },
    { attempt: 2, maxAttempts: 3, retryReason: "transient_error" },
  ]);
  const executed = attemptResults(committed, "executed").filter((action: LedgerAction.Append) => {
    const projected = effectRecord(action).evidence;
    return projected !== null && typeof projected === "object" && !Array.isArray(projected) && projected.usage !== undefined;
  });
  expect(executed.map((a: LedgerAction.Append) => a.effect.value)).toEqual([
    { phase: "result", terminal: "executed", usageProvenance: "unknown", effect: {}, evidence },
  ]);
}))));

test("visible output makes a provider failure terminal without a second admission", () => isolated(Effect.scoped(Effect.gen(function* () {
  const { executor, committed, waits } = harness();
  const expectedFailure = providerFailure(true);
  let calls = 0;
  const actual = yield* failure(
    runChatAttempts(executor, () => Effect.gen(function* () {
      calls += 1;
      return yield* expectedFailure;
    }), undefined, {}),
  );
  expect(actual).toBeInstanceOf(LlmRunFailure);
  expect(actual).toMatchObject({ _tag: "LlmRunFailure" });
  expect(calls).toBe(1);
  expect(waits).toEqual([]);
  expect(intents(committed, "attempt")).toHaveLength(1);
}))));

test("retry cap retains three failed children and never invokes a fourth body", () => isolated(Effect.scoped(Effect.gen(function* () {
  const { executor, committed, waits } = harness();
  let calls = 0;
  expect(yield* failure(
    runChatAttempts(executor, () => Effect.gen(function* () {
      calls += 1;
      return yield* providerFailure();
    }), undefined, {}),
  )).toMatchObject({ _tag: "LlmRunFailure" });
  expect(calls).toBe(3);
  expect(waits).toEqual([0, 0]);
  expect(intents(committed, "attempt")).toHaveLength(3);
}))));

test("retry re-evaluates policy and context before admitting another child", () => isolated(Effect.scoped(Effect.gen(function* () {
  for (const refuse of ["policy", "context"] as const) {
    const { executor, committed } = harness({
      policy: compiledPolicy(
        refuse === "policy"
          ? [
              {
                name: "retry-denied",
                kind: "llm",
                phase: "pre",
                priority: 1000,
                generation: 1,
                match: { encodingVersion: 1, value: { op: "retry" } },
                verdict: { encodingVersion: 1, value: { type: "deny", reason: "denied" } },
              },
            ]
          : [],
      ),
    });
    let calls = 0;
    expect(yield* failure(
      executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent: LedgerAction.Receipt) =>
        executor.runAttempts(parent, {
          classify: (error) => fakeClassifyFailure({ error }),
          prepare: (attempt: number) => Effect.succeed({
            request: { op: attempt === 1 ? "chat" : "retry", intent: {}, effect: {} },
            admit: () => attempt > 1 ? Effect.fail(new AgentFailure({ operation: "context.admit", cause: "denied" })) : Effect.void,
            body: () => Effect.gen(function* () {
              calls += 1;
              return yield* providerFailure();
            }),
          }),
        }),
      ),
    )).toMatchObject({ _tag: refuse === "policy" ? "PolicyDenied" : "AgentFailure" });
    expect(calls).toBe(1);
    expect(intents(committed, "attempt")).toHaveLength(1);
  }
}))));

test("interrupt cancels an exactly registered backoff without another provider admission", () => isolated(Effect.scoped(Effect.gen(function* () {
  const registered = Promise.withResolvers<void>();
  const controller = new AbortController();
  let cancelled = false;
  const { executor, committed } = harness({
    signal: controller.signal,
    retryAlarm: {
      arm: () => Effect.void,
      settle: () => Effect.void,
      wait: (_fireAt: number, signal?: AbortSignal) =>
        Effect.callback<void>((resume: (effect: Effect.Effect<void>) => void) => {
          signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resume(Effect.interrupt);
            },
            { once: true },
          );
          registered.resolve();
        }),
    },
  });
  const running = yield* Effect.forkScoped(Effect.exit(runChatAttempts(executor, () => Effect.fail(providerFailure()), undefined, {})));
  yield* Effect.promise(() => registered.promise).pipe(Effect.timeout("5 seconds"));
  controller.abort();
  const terminal = yield* Fiber.join(running);
  expect(Exit.isSuccess(terminal) ? terminal.value : Cause.hasInterrupts(terminal.cause)).toMatchObject({ terminal: "interrupted" });
  expect(cancelled).toBe(true);
  expect(intents(committed, "attempt")).toHaveLength(1);
}))));

test.each([
  "approve",
  "refuse",
] as const)("retry approval %s settles the captured child without reconstructing the provider call", (decision: "approve" | "refuse") => isolated(Effect.scoped(Effect.gen(function* () {
  const waiting = Promise.withResolvers<void>();
  const recording = yield* requestLedger({
    onRequest: (request: SessionTransition.Request) => {
      if (request.state === "open") waiting.resolve();
    },
  });
  const { executor } = harness({
    ...recording,
    policy: compiledPolicy([
      {
        name: "retry-approval",
        kind: "llm",
        phase: "pre",
        priority: 1000,
        generation: 1,
        match: { encodingVersion: 1, value: { op: "retry" } },
        verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
      },
    ]),
    authorizeApproval: () => Effect.succeed({
      kind: "owner",
      principalId: "owner",
      evidenceId: "authenticated",
    }),
  });
  let calls = 0;
  let prepared = 0;
  const running = executor.run({ kind: "llm", op: "chat", intent: {}, effect: {} }, (parent: LedgerAction.Receipt) =>
    executor.runAttempts(parent, {
      classify: (error) => fakeClassifyFailure({ error }),
      prepare: (attempt: number) => Effect.sync(() => {
        prepared += 1;
        return {
          request: { op: attempt === 1 ? "chat" : "retry", intent: { attempt }, effect: {} },
          admit: () => Effect.void,
          body: () => Effect.gen(function* () {
            calls += 1;
            if (calls === 1) return yield* providerFailure();
            return { type: "stop" };
          }),
        };
      }),
    }),
  );
  const terminal = yield* Effect.forkScoped(Effect.result(running));
  yield* Effect.promise(() => waiting.promise).pipe(Effect.timeout("5 seconds"));
  expect(calls).toBe(1);
  const approvals = executor.approvals;
  const request = approvals?.pending()[0];
  if (approvals === undefined || request === undefined) throw new Error("missing retry approval");
  expect(
    intents(sessionTree(isolatedLedger().kernel, recording.identity.sessionId), "attempt").map((action: LedgerAction.Append) => action.id),
  ).toContain(request.id);
  yield* approvals.answer({ request, credential: "proof", decision });
  const result = yield* Fiber.join(terminal);
  if (decision === "approve") expect(result).toMatchObject({ _tag: "Success", success: { terminal: "executed" } });
  else {
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PolicyDenied" } });
    expect(
      (sessionTree(isolatedLedger().kernel, recording.identity.sessionId))
        .filter((action: LedgerAction.Node) => action.kind === "llm")
        .map((action: LedgerAction.Node) => action.effect.value),
    ).toContainEqual(
      expect.objectContaining({
        terminal: "blocked_pre",
        reason: "approval_refused",
      }),
    );
  }
  expect(calls).toBe(decision === "approve" ? 2 : 1);
  expect(prepared).toBe(2);
  expect(intents(sessionTree(isolatedLedger().kernel, recording.identity.sessionId), "logical")).toHaveLength(1);
}))));

test("the default retry port commits the retry.scheduled alarm before the wait and consumes it exactly once", () => isolated(Effect.scoped(Effect.gen(function* () {
  const recording = yield* requestLedger();
  const executor = testExecutor({
    ...recording,
    policy: compiledPolicy(),
    observations: { publish: () => undefined },
  });
  let calls = 0;
  yield* runChatAttempts(executor, () => Effect.gen(function* () {
      calls += 1;
      if (calls === 1) return yield* providerFailure();
      return { type: "stop" };
    }));
  expect(calls).toBe(2);
  const actions = sessionTree(isolatedLedger().kernel, recording.identity.sessionId);
  const attemptIntents = intents(actions, "attempt");
  expect(attemptIntents).toHaveLength(2);
  // The chain-backed retry port arms `<attemptId>:retry` (arm:1)
  // before the wait; the settled attempt retires the chain (arm:2, at: null).
  const alarmId = `${attemptIntents[0]?.id}:retry`;
  const armed = LedgerAction.Node.parse(actions.find((action: LedgerAction.Node) => action.id === `${alarmId}:arm:1`));
  expect(armed.kind).toBe("alarm");
  expect(armed.intent.value).toMatchObject({
    op: "arm",
    purpose: "retry",
    at: 100,
    payload: { attempt: 1, reason: "transient_error" },
  });
  const secondIntent = LedgerAction.Node.parse(attemptIntents[1]);
  // Record before act: the armed schedule precedes the re-attempt; the retire
  // arm is the consumed-once evidence (supersede still folds at delivery).
  expect(armed.ordinal).toBeLessThan(secondIntent.ordinal);
  const alarmRows = actions.filter((action: LedgerAction.Node) => action.kind === "alarm");
  expect(alarmRows.map((action: LedgerAction.Node) => action.id)).toEqual([
    `${alarmId}:arm:1`,
    `${alarmId}:arm:2`,
  ]);
  const retire = LedgerAction.Node.parse(alarmRows[1]);
  expect(retire.intent.value).toMatchObject({ op: "arm", at: null });
}))));
