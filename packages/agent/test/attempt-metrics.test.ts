import { expect, test } from "bun:test";
import { LedgerAction } from "@openomni/protocol";
import { type AttemptEvidence, LlmRunFailure } from "../src/core/llm";
import { FakeProviderError } from "./helpers/fake-llm";
import { Effect } from "effect";
import { testExecutor } from "./helpers/executor";
import { allowAllPolicy } from "./helpers/compiled-policy";
import { requestLedger } from "./helpers/effect-g1";
import { runChatAttempts } from "./helpers/chat-attempts";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { attemptUsage, toolWallMs } from "../src/core/metrics";
import { createTestAgent, recordingExecutor } from "./helpers/effect-g2";
import { mockProviderModel } from "./helpers/mock-llm";
import { runInput } from "./helpers/run-input";
import { createAssistantMessage } from "../src/core/message-factory";
import { messageSource } from "./helpers/message-source";

function result(id: string, parentId: string, evidence: LedgerAction.Node["effect"]["value"],
  usageProvenance: "reported" | "estimated" | "unknown" = "unknown") {
  return LedgerAction.Node.parse({
    id,
    parentId,
    sessionId: "metrics",
    kind: "llm",
    ordinal: id === "first" ? 1 : 2,
    ts: 1_000,
    intent: { encodingVersion: 1, value: { phase: "result" } },
    effect: { encodingVersion: 1, value: { phase: "result", evidence, usageProvenance } },
    prevHash: "before",
    actionHash: "after",
    irreversible: true,
  });
}

test("failed billed usage is read once from its settled physical attempt", () => {
  const failed = result("first", "physical-attempt", {
    failures: [{ tag: "LlmRunFailure", usage: {
      inputTokens: 7, outputTokens: 0,
    } }],
  }, "reported");
  expect(attemptUsage([failed, failed])).toEqual([{
    attemptId: "physical-attempt",
    provenance: "reported",
    inputTokens: 7,
    outputTokens: 0,
  }]);
});

test("unmarked usage is unknown rather than an invented zero or provider report", () => {
  const attempt = result("first", "uncounted-attempt", {});
  expect(attemptUsage([attempt])).toEqual([{
    attemptId: "uncounted-attempt",
    provenance: "unknown",
    inputTokens: null,
    outputTokens: null,
  }]);
  const estimated = result("second", "estimated-attempt", {
    usage: { inputTokens: 3, outputTokens: 1 },
  }, "estimated");
  expect(attemptUsage([estimated])[0]?.provenance).toBe("estimated");
});

test("overlapping tools consume wall duration by union rather than sum", () => {
  expect(toolWallMs([{ start: 10, end: 40 }, { start: 20, end: 50 }, { start: 60, end: 70 }]))
    .toBe(50);
});

test("a real committed failed attempt contributes billed usage once", () =>
  isolated(Effect.gen(function* () {
    const { ledger, identity, clock, entropy } = yield* requestLedger({ id: "metrics-session" });
    const executor = testExecutor({
      ledger,
      identity,
      clock,
      entropy,
      random: () => 0,
      policy: allowAllPolicy,
      observations: { publish: () => undefined },
      retryAlarm: { arm: () => Effect.void, wait: () => Effect.void, settle: () => Effect.void },
    });
    let attempts = 0;
    yield* runChatAttempts(executor, () => Effect.gen(function* () {
      attempts += 1;
      if (attempts === 1) return yield* new LlmRunFailure({
        message: "overloaded", aborted: false, contextOverflow: false,
        visibleOutput: false, retryAfterMs: 0,
        cause: new FakeProviderError({
          message: "overloaded", statusCode: 529, responseHeaders: { "retry-after-ms": "0" }, isRetryable: true,
        }),
        usageProvenance: "reported",
        usage: {
          inputTokens: 7, outputTokens: 0, reasoningTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        },
      });
      return { type: "stop" };
    }));
    const kernel = isolatedLedger().kernel;
    const page = kernel.historyPage("metrics-session", { afterRevision: 0, limit: 256 });
    const entries = attemptUsage(page.actions);
    expect(attempts).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      inputTokens: 7, outputTokens: 0, provenance: "reported",
    });
    expect(entries.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0)).toBe(7);
  })));

/**
 * The port's attempt evidence per provenance (#1352): the call layer decides
 * `reported | estimated | unknown` beside its stream decoder (tested in
 * packages/llm); the core records whatever the port states, never a default.
 */
function evidenceOf(provenance: "reported" | "estimated" | "unknown"): AttemptEvidence {
  const counts = provenance === "estimated" ? { inputTokens: 5, outputTokens: 2 } : { inputTokens: 0, outputTokens: 0 };
  return {
    usage: { ...counts, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    usageProvenance: provenance,
    visibleOutput: true,
    finishReason: "stop",
    credential: null,
  };
}

test.each(["reported", "estimated", "unknown"] as const)(
  "a port stop records %s usage through the agent and executor",
  (provenance) => isolated(Effect.gen(function* () {
    const { executor, committed } = recordingExecutor();
    const agent = createTestAgent({
      model: { provider: "anthropic", id: mockProviderModel.id },
      events: { publish: () => undefined },
      executor,
      execution: executor,
      llm: {
        resolveModel: () => Effect.succeed(mockProviderModel),
        run: (input, sink) => Effect.sync(() => {
          sink.onMessage(createAssistantMessage("answer", input.messages.at(-1)?.info.id ?? "", input.trace.sessionId, messageSource));
          return { type: "stop", evidence: evidenceOf(provenance) };
        }),
      },
    });
    yield* agent.run(runInput([{ role: "user", content: "hello" }]));
    const rows = committed.map((action, index) => LedgerAction.Node.parse({
      ...action, ordinal: index + 1, prevHash: "before", actionHash: "after",
    }));
    const usage = attemptUsage(rows);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.provenance).toBe(provenance);
    if (provenance === "reported") expect(usage[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    if (provenance === "estimated") expect(usage[0]?.inputTokens).toBeGreaterThan(0);
    if (provenance === "unknown") expect(usage[0]).toMatchObject({ inputTokens: null, outputTokens: null });
  })),
);
