import { memoryExecutionReads } from "./helpers/execution-reads";
import { testExecutor } from "./helpers/executor";
import type { ResolvedExecutorOptions } from "../src/core/loop/executor";
import { catalogLayer, executorLayer } from "./helpers/service-layers";
import { describe, expect, test } from "bun:test";
import { stringQueryTool } from "./helpers/query-tool";
import { nth } from "./helpers/nth";
import { canonicalDigest, LedgerAction, type PlainObject, type PlainValue, } from "@openomni/protocol";
import { createTurnDispatcher } from "../src/plugins/tool";
import type { DurableExecutor, ExecutionBatchItem, ExecutionResult, } from "../src/core/loop/executor";
import type { WaveControl } from "../src/core/loop/tool";
import { CommitRefused, AgentFailure } from "../src/core/store/errors";
import { failure } from "./helpers/effect-g1";
import { Effect } from "effect";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { requestLedger } from "./helpers/request-ledger";

import { compiledPolicy } from "./helpers/compiled-policy";
import { TEST_APPROVAL_POLICY } from "./helpers/approval-policy";

function runBatch(
  executor: DurableExecutor,
  items: readonly ExecutionBatchItem[],
  control: WaveControl,
) {
  return isolated(executor.runBatch(items, control));
}
function recover(executor: DurableExecutor) {
  return isolated(executor.recover());
}

/** One tool run whose commit lane fails; returns the squashed error and body count. */
async function failedToolRun(executor: DurableExecutor, output: PlainObject) {
  let bodies = 0;
  const error = await isolated(
    failure(
      executor.runBatch(
        [
          {
            request: toolRequest,
            body: () =>
              Effect.sync(() => {
                bodies += 1;
                return output;
              }),
          },
        ],
        { signal: new AbortController().signal },
      ),
    ),
  );
  return { error, bodies: () => bodies };
}

/** The executed terminal must carry the defect as evidence, not as a rollback proof. */
function expectIrreversibleDefect(
  actions: readonly LedgerAction.Node[],
  results: readonly ExecutionResult[],
  result: PlainObject,
  cause: string,
) {
  expect(results[0]).toMatchObject({ terminal: "executed", failure: { _tag: "AgentFailure" } });
  expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
    terminal: "executed",
    disposition: "irreversible",
    result,
    evidence: { failures: [], defects: [{ name: "Error", cause }], interrupted: false },
  });
}

function harness() {
  const actions: LedgerAction.Node[] = [];
  let sequence = 0;
  const options: ResolvedExecutorOptions = {
    approvalPolicy: TEST_APPROVAL_POLICY,
    identity: { sessionId: "session", role: "resident", parentActionId: "turn", turnId: "turn" },
    policy: compiledPolicy(),
    clock: () => 100,
    entropy: () => `action:${++sequence}`, random: () => 0,
    observations: { publish: () => undefined },
    ledger: {
      ...memoryExecutionReads(() => actions),
      commit: (action) =>
        Effect.sync(() => {
          const node = LedgerAction.Node.parse({
            ...action,
            ordinal: actions.length + 1,
            prevHash: "fixture-prev",
            actionHash: "fixture-hash",
          });
          actions.push(node);
          return { action: node, revision: node.ordinal };
        }),
    },
  };
  return { actions, options };
}

function record(value: PlainValue): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function effect(action: LedgerAction.Node): PlainObject {
  const value = action.effect.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object effect");
  return value;
}

function intentOf(action: LedgerAction.Node): PlainObject {
  const value = action.intent.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object intent");
  return value;
}

function resultsOf(actions: readonly LedgerAction.Node[], kind: LedgerAction.Kind) {
  return actions.filter((action) => action.kind === kind && effect(action).phase === "result");
}

function openIntent(
  id: string,
  kind: LedgerAction.Kind,
  parentId: string,
  intent: PlainObject,
): LedgerAction.Append {
  return {
    id,
    parentId,
    sessionId: "session",
    kind,
    ts: 1,
    intent: { encodingVersion: 1, value: { phase: "intent", ...intent } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
  };
}

/** The chat result row that settles the open intent `intentId`. */
function settledResult(
  intentId: string,
  kind: LedgerAction.Kind,
  effect: PlainObject,
): LedgerAction.Append {
  return {
    id: `${intentId}-result`,
    parentId: intentId,
    sessionId: "session",
    kind,
    ts: 2,
    intent: { encodingVersion: 1, value: { phase: "result", op: "chat" } },
    effect: { encodingVersion: 1, value: { phase: "result", ...effect } },
    irreversible: true,
  };
}

const toolRequest = {
  kind: "tool",
  op: "write",
  intent: { path: "a" },
  effect: { category: "mutation" },
  toolObservation: { turnId: "turn", callId: "call-1" },
} as const;

/** A post-phase denial of every write: the terminal is blocked_post, never re-decided. */
const denyWritePost: Parameters<typeof compiledPolicy>[0] = [
  {
    name: "deny-write-post",
    kind: "tool",
    phase: "post",
    match: { encodingVersion: 1, value: { op: "write" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "post_denied" } },
    priority: 500,
    generation: 1,
  },
];

test("the body receives deeply frozen admitted input", async () => {
  const { options } = harness();
  const admittedInput = { nested: { items: [{ value: "admitted" }] } };
  const result = await isolated(
    testExecutor(options).run(
      { ...toolRequest, intent: admittedInput },
      (_receipt: LedgerAction.Receipt, input: PlainValue) =>
        Effect.sync(() => {
          const nested = record(record(input).nested ?? null);
          const items = nested.items;
          expect(input).toEqual(admittedInput);
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(nested)).toBe(true);
          expect(Array.isArray(items)).toBe(true);
          expect(Object.isFrozen(items)).toBe(true);
          expect(Object.isFrozen(Array.isArray(items) ? items[0] : null)).toBe(true);
          return { status: "success" };
        }),
    ),
  );
  expect(result).toEqual({ terminal: "executed", value: { status: "success" } });
  expect(Object.isFrozen(admittedInput)).toBe(false);
});

test.each([
  "corrupted",
  null,
  42,
])("recovery rejects a corrupted recorded verdict (%j) before the body", async (verdict: PlainValue) => {
  const { actions, options } = harness();
  const decision = await isolated(
    options.ledger.commit({
      ...openIntent("decision", "policy.decision", "turn", {}),
      intent: {
        encodingVersion: 1,
        value: {
          hook: "tool.pre",
          op: toolRequest.op,
          generation: options.policy.generation,
          matchedRuleIds: [],
          verdict,
          inputHash: canonicalDigest({
            kind: "tool",
            phase: "pre",
            op: toolRequest.op,
            role: "resident",
            sessionId: "session",
            value: toolRequest.intent,
          }),
        },
      },
      effect: { encodingVersion: 1, value: { reason: null } },
    }),
  );
  const original = await isolated(
    options.ledger.commit(
      openIntent("original", "tool", "turn", {
        op: toolRequest.op,
        policyDecisionId: decision.action.id,
        value: toolRequest.intent,
      }),
    ),
  );
  const before = structuredClone(actions);
  let bodies = 0;
  const error = await isolated(
    failure(
      testExecutor(options).run({ ...toolRequest, originalAction: original.action }, () =>
        Effect.sync(() => {
          bodies++;
          return {};
        }),
      ),
    ),
  );
  expect(error).toMatchObject({ _tag: "ExecutionApprovalError", code: "stale_approval" });
  expect(bodies).toBe(0);
  expect(actions).toEqual(before);
});

describe("recovered gate evidence (#1251 r4)", () => {
  /** A committed pre-decision for `toolRequest`, optionally carrying gate evidence. */
  function commitDecision(
    options: ResolvedExecutorOptions,
    gate: PlainValue | undefined,
  ) {
    const evaluation = options.policy.evaluate({
      kind: "tool", phase: "pre", op: toolRequest.op, role: "resident",
      sessionId: "session", value: toolRequest.intent,
    });
    return isolated(
      options.ledger.commit({
        ...openIntent("decision", "policy.decision", "turn", {}),
        intent: { encodingVersion: 1, value: {
          hook: "tool.pre", op: toolRequest.op, generation: evaluation.generation,
          matchedRuleIds: [...evaluation.matchedRuleIds], verdict: evaluation.verdict,
          inputHash: evaluation.inputHash, transforms: [],
          ...(gate === undefined ? {} : { gate }),
        } },
        effect: { encodingVersion: 1, value: { reason: null } },
      }),
    );
  }

  async function recoveredRun(options: ResolvedExecutorOptions, decisionId: string) {
    const original = await isolated(
      options.ledger.commit(
        openIntent("original", "tool", "turn", {
          op: toolRequest.op, policyDecisionId: decisionId, value: toolRequest.intent,
        }),
      ),
    );
    let bodies = 0;
    const outcome = await isolated(
      Effect.result(
        testExecutor(options).run({ ...toolRequest, originalAction: original.action }, () =>
          Effect.sync(() => {
            bodies++;
            return { status: "recovered" };
          }),
        ),
      ),
    );
    return { outcome, bodies: () => bodies };
  }

  test("absent evidence is a pre-contract record: the recorded bytes admit", async () => {
    const { options } = harness();
    const decision = await commitDecision(options, undefined);
    const { outcome, bodies } = await recoveredRun(options, decision.action.id);
    expect(outcome).toMatchObject({
      success: { terminal: "executed", value: { status: "recovered" } },
    });
    expect(bodies()).toBe(1);
  });

  test("well-formed evidence replays and admits", async () => {
    const { options } = harness();
    const recorded = options.policy.evaluate({
      kind: "tool", phase: "pre", op: toolRequest.op, role: "resident",
      sessionId: "session", value: toolRequest.intent,
    }).gate;
    if (recorded === undefined) throw new Error("gate evidence missing");
    const decision = await commitDecision(options, recorded);
    const { outcome, bodies } = await recoveredRun(options, decision.action.id);
    expect(outcome).toMatchObject({
      success: { terminal: "executed", value: { status: "recovered" } },
    });
    expect(bodies()).toBe(1);
  });

  test("present but malformed evidence is refused, never routed to byte admission", async () => {
    const { options } = harness();
    const recorded = options.policy.evaluate({
      kind: "tool", phase: "pre", op: toolRequest.op, role: "resident",
      sessionId: "session", value: toolRequest.intent,
    }).gate;
    if (recorded === undefined) throw new Error("gate evidence missing");
    // Strip the required output: the record is present yet no longer a decision.
    const { output: _output, ...malformed } = recorded;
    const decision = await commitDecision(options, malformed);
    const { outcome, bodies } = await recoveredRun(options, decision.action.id);
    expect(outcome).toMatchObject({
      failure: { _tag: "ExecutionApprovalError", code: "stale_approval" },
    });
    expect(bodies()).toBe(0);
  });
});

describe("completion recovery", () => {
  for (const site of ["before_persist", "after_persist"] as const) {
    test(`a result commit throwing ${site} keeps one terminal and never replays the body`, async () => {
      const { actions, options } = harness();
      const commit = options.ledger.commit;
      let injected = false;
      // Lose the executed terminal's commit once, before or after it persisted.
      const storageLost = new AgentFailure({ operation: "commit", cause: "storage_lost" });
      const lose = (action: LedgerAction.Append) =>
        Effect.gen(function* () {
          injected = true;
          if (site === "after_persist") yield* commit(action);
          return yield* storageLost;
        });
      const executor = testExecutor({
        ...options,
        ledger: {
          ...options.ledger,
          commit: (action) =>
            !injected &&
            action.kind === "tool" &&
            record(action.effect.value).terminal === "executed"
              ? lose(action)
              : commit(action),
        },
      });
      const { error, bodies } = await failedToolRun(executor, {
        status: "success",
        output: "written",
      });
      expect(error).toMatchObject({ _tag: "CommitFailed", error: storageLost });
      expect(bodies()).toBe(1);
      expect(resultsOf(actions, "tool")).toHaveLength(site === "after_persist" ? 1 : 0);
      await recover(executor);
      const terminals = resultsOf(actions, "tool");
      expect(terminals).toHaveLength(1);
      if (site === "after_persist") {
        expect(effect(nth(terminals, 0))).toMatchObject({
          terminal: "executed",
          result: { status: "success", output: "written" },
        });
      } else {
        expect(effect(nth(terminals, 0))).toMatchObject({
          terminal: "outcome_unknown",
          callId: "call-1",
          error: { name: "ProcessLost" },
          recovery: {
            site: "crash",
            classification: "ambiguous_no_replay",
            proof: "indeterminate",
            rawSettled: false,
            revertReceipt: null,
          },
        });
      }
      const before = structuredClone(actions);
      await recover(executor);
      expect(actions).toEqual(before);
      expect(bodies()).toBe(1);
    });
  }

  test("a throwing model-facing projection preserves the executed body's evidence", async () => {
    const { actions, options } = harness();
    const executor = testExecutor(options);
    const results = await runBatch(
      executor,
      [
        {
          request: {
            ...toolRequest,
            toolResult: () => {
              throw new Error("projection_failed");
            },
          },
          body: () => Effect.succeed({ status: "success", output: "written" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expectIrreversibleDefect(
      actions,
      results,
      { status: "success", output: "written" },
      "projection_failed",
    );
    expect(effect(nth(resultsOf(actions, "tool"), 0)).toolResult).toBeUndefined();
  });

  test("a refused post decision propagates without a fabricated verdict and recovers without replay", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    const executor = testExecutor({
      ...options,
      ledger: {
        ...options.ledger,
        commit: (action) =>
          action.kind === "policy.decision" && record(action.intent.value).hook === "tool.post"
            ? Effect.fail(new AgentFailure({ operation: "commit", cause: "decision_lost" }))
            : commit(action),
      },
    });
    const { error, bodies } = await failedToolRun(executor, { status: "success" });
    expect(error).toMatchObject({
      _tag: "CommitFailed",
      error: { _tag: "AgentFailure", cause: "decision_lost" },
    });
    expect(actions.filter((action) => action.kind === "policy.decision")).toHaveLength(1);
    expect(resultsOf(actions, "tool")).toHaveLength(0);
    await recover(executor);
    expect(resultsOf(actions, "tool")).toHaveLength(1);
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "outcome_unknown",
      recovery: { site: "crash", proof: "indeterminate" },
    });
    expect(actions.filter((action) => action.kind === "policy.decision")).toHaveLength(1);
    expect(bodies()).toBe(1);
  });

  test("a blocked_post terminal lost after persistence survives recovery without re-deciding or reverting twice", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    let injected = false;
    const executor = testExecutor({
      ...options,
      policy: compiledPolicy(denyWritePost),
      ledger: {
        ...options.ledger,
        commit: (action) =>
          Effect.gen(function* () {
            const receipt = yield* commit(action);
            if (
              action.kind === "tool" &&
              effect(receipt.action).terminal === "blocked_post" &&
              !injected
            ) {
              injected = true;
              return yield* new AgentFailure({ operation: "commit", cause: "storage_lost" });
            }
            return receipt;
          }),
      },
    });
    let reverted = 0;
    const error = await isolated(
      failure(
        executor.runBatch(
          [
            {
              request: {
                ...toolRequest,
                revert: () =>
                  Effect.sync(() => {
                    reverted += 1;
                  }),
              },
              body: () => Effect.succeed({ status: "success" }),
            },
          ],
          { signal: new AbortController().signal },
        ),
      ),
    );
    expect(reverted).toBe(1);
    expect(error).toMatchObject({
      _tag: "CommitFailed",
      error: { _tag: "AgentFailure", cause: "storage_lost" },
    });
    const before = structuredClone(actions);
    await recover(executor);
    expect(actions).toEqual(before);
    expect(reverted).toBe(1);
    const terminals = resultsOf(actions, "tool");
    expect(terminals).toHaveLength(1);
    expect(effect(nth(terminals, 0))).toMatchObject({
      terminal: "blocked_post",
      disposition: "reverted",
      reason: "post_denied",
    });
  });

  test("a throwing reverter is never proof of rollback", async () => {
    const { actions, options } = harness();
    const executor = testExecutor({ ...options, policy: compiledPolicy(denyWritePost) });
    const results = await runBatch(
      executor,
      [
        {
          request: {
            ...toolRequest,
            revert: () => Effect.die(new Error("revert_failed")),
          },
          body: () => Effect.succeed({ status: "success" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expectIrreversibleDefect(actions, results, { status: "success" }, "revert_failed");
  });

  test("a refused recovery commit stays pending: the typed refusal propagates and nothing is appended blindly", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    const stale = new CommitRefused({
      sessionId: "session",
      reason: "fence",
      expectedRevision: 1,
      currentRevision: 1,
      fence: 1,
      currentFence: 2,
    });
    let bodyDone = false;
    const executor = testExecutor({
      ...options,
      ledger: {
        ...options.ledger,
        commit: (action) => (bodyDone ? Effect.fail(stale) : commit(action)),
      },
    });
    const run = executor.runBatch(
      [
        {
          request: toolRequest,
          body: () =>
            Effect.sync(() => {
              bodyDone = true;
              return { status: "success" };
            }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(await isolated(failure(run))).toMatchObject({ _tag: "CommitFailed", error: stale });
    const before = structuredClone(actions);
    expect(await isolated(failure(executor.recover()))).toMatchObject({
      _tag: "CommitFailed",
      error: stale,
    });
    expect(actions).toEqual(before);
    expect(resultsOf(actions, "tool")).toHaveLength(0);
    expect(actions.filter((action) => action.kind === "tool")).toHaveLength(1);
  });
});

test("SQLite recovery settles all 257 open operations across the page boundary exactly once", () =>
  isolated(
    Effect.gen(function* () {
      const recording = requestLedger({ id: "session", turnId: "turn" });
      const intents = Array.from({ length: 257 }, (_value: undefined, index: number) =>
        openIntent(`pending:${index}`, "tool", "turn", { op: "write", turnId: "turn" }),
      );
      expect(recording.commitBatch(intents).ok).toBe(true);
      const executor = testExecutor({
        ...recording,
        policy: compiledPolicy(),
        observations: { publish: (): void => undefined },
      });
      yield* executor.recover();
      for (const intent of intents) {
        const result = isolatedLedger().kernel.resultFor("session", intent.id);
        if (result === undefined) throw new Error(`missing result for ${intent.id}`);
        expect(effect(result).terminal).toBe("outcome_unknown");
        expect(effect(result).recovery).toEqual({
          site: "crash",
          classification: "ambiguous_no_replay",
          proof: "indeterminate",
          proofReceipt: null,
          revertReceipt: null,
          rawSettled: false,
        });
      }
      expect(isolatedLedger().kernel.openOperationsPage("session", "turn")).toEqual([]);
      const revision = isolatedLedger().kernel.row("session").revision;
      yield* executor.recover();
      expect(isolatedLedger().kernel.row("session").revision).toBe(revision);
    }),
  ));

describe("crash-open recovery", () => {
  test("classification is pinned on the intent and defaults by kind", async () => {
    const { actions, options } = harness();
    const executor = testExecutor(options);
    await runBatch(
      executor,
      [
        { request: toolRequest, body: () => Effect.succeed({ status: "success" }) },
        {
          request: { ...toolRequest, op: "poll", recovery: "endpoint_idempotent" },
          body: () => Effect.succeed({ status: "success" }),
        },
        {
          request: { kind: "message", op: "assistant", intent: {}, effect: {} },
          body: () => Effect.succeed({ text: "hi" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    const intents = actions.filter((action) => intentOf(action).phase === "intent");
    expect(intents.map((action) => intentOf(action).recovery)).toEqual([
      "ambiguous_no_replay",
      "endpoint_idempotent",
      "local_transactional",
    ]);
  });

  test("an ordinary open tool settles outcome_unknown once, with no body and an unknown settlement", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit(
        openIntent("lost-tool", "tool", "turn", {
          op: "bash",
          turnId: "turn",
          callId: "call-9",
          waveId: "lost-tool",
          value: {},
          effect: { category: "execution" },
        }),
      ),
    );
    const executor = testExecutor(options);
    await recover(executor);
    expect(actions).toHaveLength(2);
    expect(effect(nth(actions, 1))).toMatchObject({
      terminal: "outcome_unknown",
      callId: "call-9",
      error: { name: "ProcessLost" },
      toolResult: { toolCallId: "call-9", toolName: "bash", isError: true, settlement: "unknown" },
      recovery: {
        site: "crash",
        classification: "ambiguous_no_replay",
        proof: "indeterminate",
        proofReceipt: null,
        rawSettled: false,
      },
    });
    await recover(executor);
    expect(actions).toHaveLength(2);
  });

  test("a request-bearing wave is left to its captured dispatcher", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit(
        openIntent("guarded", "tool", "turn", {
          op: "send",
          turnId: "turn",
          callId: "call-g",
          waveId: "guarded",
          approvalRequired: true,
          value: {},
          effect: {},
        }),
      ),
    );
    await isolated(
      options.ledger.commit(
        openIntent("sibling", "tool", "turn", {
          op: "read",
          turnId: "turn",
          callId: "call-s",
          waveId: "guarded",
          approvalRequired: false,
          value: {},
          effect: {},
        }),
      ),
    );
    await recover(testExecutor(options));
    expect(actions).toHaveLength(2);
  });

  test("other turns and already-settled intents are untouched", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit(
        openIntent("other", "tool", "turn-2", {
          op: "bash",
          turnId: "turn-2",
          waveId: "other",
          value: {},
          effect: {},
        }),
      ),
    );
    await isolated(
      options.ledger.commit(openIntent("done", "llm", "turn", { op: "chat", value: {} })),
    );
    await isolated(
      options.ledger.commit(settledResult("done", "llm", { terminal: "executed", effect: {} })),
    );
    await recover(testExecutor(options));
    expect(actions).toHaveLength(3);
  });

  test("a lost provider attempt makes the logical llm outcome_unknown, never a silent retry", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit(openIntent("lost-llm", "llm", "turn", { op: "chat", value: {} })),
    );
    await isolated(
      options.ledger.commit(
        openIntent("attempt-1", "llm", "lost-llm", { op: "chat", value: { attempt: 1 } }),
      ),
    );
    await recover(testExecutor(options));
    expect(
      actions.map((action) => [action.kind, action.parentId, effect(action).terminal]),
    ).toEqual([
      ["llm", "turn", undefined],
      ["llm", "lost-llm", undefined],
      ["llm", "attempt-1", "outcome_unknown"],
      ["llm", "lost-llm", "outcome_unknown"],
    ]);
    expect(effect(nth(actions, 3))).toMatchObject({
      recovery: { classification: "ambiguous_no_replay", proof: "indeterminate" },
    });
  });

  test.each([
    "success",
    "failure",
    "reasoning",
  ] as const)("recovery keeps billed %s evidence and never proves a visible prefix absent", async (outcome:
    | "success"
    | "failure"
    | "reasoning") => {
    const { actions, options } = harness();
    const usage = { inputTokens: 19, outputTokens: 7, reasoningTokens: 3 };
    const visibleOutput = outcome !== "reasoning";
    const evidence: PlainObject =
      outcome === "success"
        ? { usage, visibleOutput }
        : {
            failures: [{ tag: "LlmRunFailure", usage, visibleOutput, provider: "failed-route" }],
            defects: [],
            interrupted: false,
          };
    await isolated(
      Effect.gen(function* () {
        yield* options.ledger.commit(
          openIntent("prefix-llm", "llm", "turn", { op: "chat", value: {} }),
        );
        yield* options.ledger.commit(
          openIntent("prefix-attempt", "llm", "prefix-llm", { op: "chat", value: {} }),
        );
        yield* options.ledger.commit(
          settledResult("prefix-attempt", "llm", { terminal: "executed", evidence }),
        );
      }),
    );
    const before = structuredClone(actions);
    const executor = testExecutor(options);
    await recover(executor);
    expect(actions.slice(0, before.length)).toEqual(before);
    expect(actions).toHaveLength(before.length + 1);
    expect(actions.at(-1)?.effect.value).toMatchObject({
      terminal: visibleOutput ? "outcome_unknown" : "interrupted",
      recovery: { proof: visibleOutput ? "indeterminate" : "absent" },
    });
    const settled = structuredClone(actions);
    await recover(executor);
    expect(actions).toEqual(settled);
  });

  test("an llm whose attempts all settled is interrupted from that evidence under a resume parent", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit({
        id: "resume-1",
        parentId: "turn",
        sessionId: "session",
        kind: "turn",
        ts: 1,
        intent: { encodingVersion: 1, value: { phase: "resume", turnId: "turn", resultId: "r" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        irreversible: true,
      }),
    );
    await isolated(
      options.ledger.commit(openIntent("llm-2", "llm", "resume-1", { op: "chat", value: {} })),
    );
    await isolated(
      options.ledger.commit(
        openIntent("attempt-2", "llm", "llm-2", { op: "chat", value: { attempt: 1 } }),
      ),
    );
    await isolated(
      options.ledger.commit(
        settledResult("attempt-2", "llm", {
          terminal: "executed",
          effect: {},
          evidence: {
            failures: [{ tag: "AgentFailure", operation: "chat", cause: "APIError" }],
            defects: [],
            interrupted: false,
          },
        }),
      ),
    );
    await recover(testExecutor(options));
    expect(actions).toHaveLength(5);
    expect(actions[4]).toMatchObject({ kind: "llm", parentId: "llm-2" });
    expect(effect(nth(actions, 4))).toMatchObject({
      terminal: "interrupted",
      recovery: {
        site: "crash",
        classification: "local_transactional",
        proof: "absent",
        proofReceipt: { id: "attempt-2-result" },
      },
    });
  });

  test("kernel-local projections are interrupted from ledger read-back instead of staying ambiguous", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit(openIntent("msg", "message", "turn", { op: "assistant", value: {} })),
    );
    await isolated(
      options.ledger.commit(
        openIntent("cut", "compaction", "turn", {
          op: "compact",
          value: {},
          recovery: "local_transactional",
        }),
      ),
    );
    await recover(testExecutor(options));
    expect(resultsOf(actions, "message").map((action) => effect(action).terminal)).toEqual([
      "interrupted",
    ]);
    expect(effect(nth(resultsOf(actions, "compaction"), 0))).toMatchObject({
      terminal: "interrupted",
      recovery: {
        classification: "local_transactional",
        proof: "absent",
        proofReceipt: { id: "cut" },
      },
    });
  });
});

describe("turn dispatcher recovery", () => {
  test("settles the executor's crash-open evidence before captured waves, without running tools", async () => {
    const { actions, options } = harness();
    await isolated(
      options.ledger.commit(
        openIntent("lost-echo", "tool", "turn", {
          op: "echo",
          turnId: "turn",
          callId: "call-e",
          waveId: "lost-echo",
          value: {},
          effect: {},
        }),
      ),
    );
    let executions = 0;
    const dispatcher = createTurnDispatcher(
      {
        sessionId: "session",
        role: "resident",
        actionId: "turn",
        turnId: "turn",
        ledger: options.ledger,
      },
      { approvalPolicy: TEST_APPROVAL_POLICY },
    ).pipe(
      Effect.provide(
        catalogLayer([
          stringQueryTool("echo", "echo", async () => {
            executions += 1;
            return "ok";
          }),
        ]),
      ),
      Effect.provide(executorLayer(options)),
    );
    await isolated(Effect.flatMap(dispatcher, (value) => value.executor.recover()));
    expect(executions).toBe(0);
    expect(effect(nth(actions, 1))).toMatchObject({
      terminal: "outcome_unknown",
      callId: "call-e",
    });
  });
});
