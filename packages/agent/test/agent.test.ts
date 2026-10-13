import { messageSource } from "./helpers/message-source";
import { Effect } from "effect";
import { isolated } from "./helpers/isolated";
import { createTestAgent, failure } from "./helpers/effect-g3";
import { describe, expect, it, test } from "bun:test";
import { LlmRunFailure } from "../src/core/llm";
import { FakeProviderError } from "./helpers/fake-llm";
import type { Tool } from "@openomni/protocol";
import { createAssistantMessage } from "../src/core/message-factory";
import { RunEvents } from "../src/core/turn";
import { Bus } from "./helpers/bus";
import { failureEvidence } from "../src/core/gate/decide";
import { Entropy, ObservationSink, SessionLayer, ToolCatalog } from "../src/core/ports";
import { PolicyDenied, ToolBodyFailed, AgentFailure, AgentInvariantViolation, AgentStopError, CommitFailed, CompactionExecutionError, ExecutionApprovalError, OutcomeUnknown, Interrupted, InvocationClosed, GenerationUnavailable } from "../src/core/failure";
import type { LedgerError } from "../src/core/store/errors";
import { completeModel, mockLlm, createStopOutcome, type MockLlmFn } from "./helpers/mock-llm";
import { runInput } from "./helpers/run-input";
import { assistantTextSnapshot } from "./helpers/messages";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };
function agent(run: MockLlmFn) {
  return createTestAgent({
    events: Bus,
    model,
    llm: mockLlm(run),
  });
}

test("agent foundation tags and failure evidence are runtime contracts", () => {
  expect([Entropy.key, ObservationSink.key, SessionLayer.key, ToolCatalog.key]).toEqual([
    "@openomni/agent/Entropy", "@openomni/agent/ObservationSink", "@openomni/agent/SessionLayer", "@openomni/agent/ToolCatalog",
  ]);
  expect(failureEvidence(new PolicyDenied({ phase: "pre", ruleIds: ["r"] }))).toEqual({ tag: "PolicyDenied", phase: "pre", ruleIds: ["r"] });
  expect(failureEvidence(new ToolBodyFailed({ tool: "x", cause: "bad" }))).toEqual({ tag: "ToolBodyFailed", tool: "x", cause: "bad" });
  expect(failureEvidence(new AgentFailure({ operation: "x", cause: "bad" }))).toEqual({ tag: "AgentFailure", operation: "x", cause: "bad" });
  expect(failureEvidence(new AgentFailure({ operation: "complete", cause: "bad" }))).toEqual({ tag: "AgentFailure", operation: "complete", cause: "bad" });
  expect(failureEvidence(new CompactionExecutionError({ reason: "invalid_output" }))).toEqual({ tag: "CompactionExecutionError", reason: "invalid_output" });
  expect(failureEvidence(new InvocationClosed({ tool: "x", reason: "failed" }))).toEqual({ tag: "InvocationClosed", tool: "x", reason: "failed" });
  expect(failureEvidence(new GenerationUnavailable({ generation: 2 }))).toEqual({ tag: "GenerationUnavailable", generation: 2 });
  expect(failureEvidence(new CommitFailed({ error: {} as LedgerError }))).toMatchObject({ tag: "CommitFailed" });
  expect(failureEvidence(new ExecutionApprovalError({ code: "stale_approval" }))).toEqual({ tag: "ExecutionApprovalError", code: "stale_approval" });
  expect(failureEvidence(new OutcomeUnknown({ reason: "lost" }))).toEqual({ tag: "OutcomeUnknown", reason: "lost" });
  expect(failureEvidence(new Interrupted())).toEqual({ tag: "Interrupted" });
});

/**
 * `providerErrorName` names only the provider SDK error. A
 * transport Error (the structured `TransportFailure.cause`) and a bare string
 * keep `null` and render exactly as the base journal did (`name: message`).
 */
test("LlmRunFailure evidence names a provider error and nothing else", () => {
  const attempt = { message: "attempt failed", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, aborted: false, contextOverflow: false, visibleOutput: false };
  const common = { tag: "LlmRunFailure", message: "attempt failed", retryAfterMs: null, usage: attempt.usage, aborted: false, contextOverflow: false, visibleOutput: false };

  const transport = new TypeError("fetch failed");
  expect(failureEvidence(new LlmRunFailure({ ...attempt, cause: transport })))
    .toEqual({ ...common, providerErrorName: null, cause: "TypeError: fetch failed" });

  // The port names the provider error (#1352): the core copies the name it was handed and never inspects the cause.
  const provider = new FakeProviderError({ message: "overloaded", statusCode: 529, isRetryable: true });
  expect(failureEvidence(new LlmRunFailure({ ...attempt, cause: provider, providerErrorName: provider.name })))
    .toEqual({ ...common, providerErrorName: provider.name, cause: "overloaded" });
  expect(provider.name).not.toBe("TypeError");

  expect(failureEvidence(new LlmRunFailure({ ...attempt, cause: "stream closed" })))
    .toEqual({ ...common, providerErrorName: null, cause: "stream closed" });
  expect(failureEvidence(new LlmRunFailure(attempt))).toEqual({ ...common, providerErrorName: null, cause: null });
});

describe("ChatAgent public run contract", () => {
  it("returns terminal text, step, and token usage", async () => {
    const result = await isolated(agent(async (_input, sink) => {
      sink.onMessage(assistantTextSnapshot("answer", 8, 5));
      return createStopOutcome();
    }).run(runInput([{ role: "user", content: "hello" }])));
    expect(result).toMatchObject({
      text: "answer",
      steps: [{ type: "text", content: "answer" }],
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
      finishReason: "stop",
    });
  });

  it("forwards provider options, auth, transport, and tool choice", async () => {
    let observed: Parameters<MockLlmFn>[0] | undefined;
    const transport = { baseURL: "https://proxy.test", headers: { "x-route": "test" } };
    const controller = new AbortController();
    await isolated(createTestAgent({
      events: Bus,
      model,
      auth: { type: "api", key: "secret" },
      signal: controller.signal,
      transport,
      providerOptions: { temperature: 0 },
      toolChoice: "none",
      llm: mockLlm(async (input, sink) => {
        observed = input;
        return completeModel(input, sink);
      }),
    }).run(runInput([{ role: "user", content: "hello" }])));
    expect(observed).toMatchObject({
      auth: { type: "api", key: "secret" },
      signal: controller.signal,
      transport,
      providerOptions: { temperature: 0 },
      toolChoice: "none",
    });
  });

  it("invokes onStepFinish with the exact returned step", async () => {
    const seen: Array<{ type: "text"; content: string }> = [];
    const result = await isolated(createTestAgent({
      events: Bus,
      model,
      onStepFinish: (step) => Effect.sync(() => {
        seen.push(step);
      }),
      llm: mockLlm(async (_input, sink) => {
        sink.onMessage(createAssistantMessage("done", "", "session", messageSource));
        return createStopOutcome();
      }),
    }).run(runInput([{ role: "user", content: "hello" }])));
    expect(seen).toEqual(result.steps);
  });

  it("rejects incomplete trace identity before provider execution", async () => {
    let calls = 0;
    await expect(isolated(agent(async () => {
        calls += 1;
        return createStopOutcome();
      }).run({ messages: [{ role: "user", content: "hello" }] }))).rejects.toThrow("agent run requires a trace context");
    expect(calls).toBe(0);
  });

  it("passes the configured abort signal through the tool bridge", async () => {
    let capturedContext: Tool.ExecutionContext | undefined;
    let providerSteps = 0;
    const controller = new AbortController();
    await isolated(createTestAgent({
      events: Bus,
      model,
      signal: controller.signal,
      auth: { type: "api", key: "test-key" },
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
          safe: true,
        },
      ],
      toolExecutor: (call, context) => Effect.promise(async () => {
        capturedContext = context;
        return { id: "result-1", toolCallId: call.id, output: "found" };
      }),
      llm: mockLlm(async (input, sink) => {
        providerSteps += 1;
        const parentID = input.messages.at(-1)?.info.id ?? "";
        if (providerSteps === 1) {
          const call = { id: "call-1", tool: "lookup", input: {} };
          sink.onToolCall(call);
          const message = createAssistantMessage("", parentID, input.trace.sessionId, messageSource);
          sink.onMessage({
            ...message,
            parts: [{
              id: "tool-part", sessionID: input.trace.sessionId, messageID: message.info.id,
              type: "tool", callID: call.id, tool: call.tool, state: { status: "pending", input: call.input },
            }],
          });
          // The core settles pending tool parts on a stop and runs the next turn itself.
          return { type: "stop" };
        }
        sink.onMessage(createAssistantMessage("completed", parentID, input.trace.sessionId, messageSource));
        return { type: "stop" };
      }),
    }).run(runInput([{ role: "user", content: "hello" }])));

    expect(providerSteps).toBe(2);
    expect(capturedContext?.signal).toBe(controller.signal);
  });

  it("rejects configured tools without an executor and emits no retry", async () => {
    let calls = 0;
    const retries: number[] = [];
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retries.push(1));
    const configured = createTestAgent({
      events: Bus,
      model,
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
          safe: true,
        },
      ],
      llm: mockLlm(async () => {
        calls += 1;
        return createStopOutcome();
      }),
    });
    try {
      await expect(isolated(configured.run(runInput([{ role: "user", content: "hello" }]))))
        .rejects.toThrow("toolExecutor is required when tools are provided");
      expect(retries).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("ChatAgent provider boundary failures", () => {
  it("dies with AgentInvariantViolation when the provider stops without emitting a snapshot", async () => {
    // The executor no longer synthesises an empty assistant; a stop
    // with no sink snapshot is a wiring defect, not a recoverable state.
    const defect = await isolated(failure(agent(async () => createStopOutcome())
      .run(runInput([{ role: "user", content: "hello" }]))));
    expect(defect).toBeInstanceOf(AgentInvariantViolation);
    expect((defect as Error).message).toBe("llm sink emitted no assistant snapshot");
  });
  it("fails the toolless run as a stop when the llm fold emits an empty snapshot", async () => {
    // The llm fold owns the empty-assistant fallback: an empty snapshot built
    // from the injected now/id sources is recorded, then the stop chain ends
    // the toolless run — a typed stop, never the invariant defect above.
    const error = await isolated(Effect.flip(agent(async (input, sink) => {
      sink.onMessage(createAssistantMessage("", input.messages.at(-1)?.info.id ?? "", input.trace.sessionId, { now: input.now, id: input.id }));
      return createStopOutcome();
    }).run(runInput([{ role: "user", content: "hello" }]))));
    expect(error).toBeInstanceOf(AgentStopError);
  });
  it.each([
    { name: "an object without a type", outcome: {}, message: "invalid llm execution result" },
    {
      name: "an object with an unknown type",
      outcome: { type: "unexpected" },
      message: "invalid llm execution result",
    },
    { name: "a primitive", outcome: 0, message: "invalid llm execution result" },
  ])("rejects $name", async ({ outcome, message: _message }) => {
    const controller = new AbortController();
    const malformed = createTestAgent({
      events: Bus,
      model,
      signal: controller.signal,
      llm: mockLlm(async () => {
        return outcome as never;
      }),
    });

    expect(await isolated(Effect.flip(malformed.run(runInput([{ role: "user", content: "malformed" }]))))).toBeInstanceOf(Error);
  });

  it("reports a port resolution refusal as an llm failure, keeping only its text", async () => {
    const refusal = { _tag: "ModelResolutionError", message: "model missing-model not found in provider anthropic" };
    expect(await isolated(Effect.flip(createTestAgent({
        events: Bus,
        model: { provider: "anthropic", id: "missing-model" },
        llm: { resolveModel: () => Effect.fail(refusal) },
      }).run(runInput([{ role: "user", content: "lookup" }]))))).toMatchObject({
      _tag: "AgentFailure", operation: "llm", cause: refusal.message,
    });
  });

  it("reports a port run refusal that is not an attempt failure the same way", async () => {
    expect(await isolated(Effect.flip(createTestAgent({
        events: Bus,
        model: { provider: "anthropic", id: "proxy-model" },
        llm: { run: () => Effect.fail({ _tag: "ProxyModelsError", message: "proxy offline" }) },
      }).run(runInput([{ role: "user", content: "lookup" }]))))).toMatchObject({
      _tag: "AgentFailure", operation: "llm", cause: "proxy offline",
    });
  });

  it("resolves a known model through the default provider path", async () => {
    const result = await isolated(createTestAgent({
      events: Bus,
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      llm: { run: mockLlm(completeModel).run },
    }).run(runInput([{ role: "user", content: "hello" }])));

    expect(result.finishReason).toBe("stop");
  });
});

describe("ChatAgent loop controls", () => {
  it("creates an instance with a run method", () => {
    expect(typeof agent(async () => createStopOutcome()).run).toBe("function");
  });

  it("honors an already-aborted signal before provider execution", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    expect(await isolated(Effect.flip(createTestAgent({
        events: Bus,
        model,
        signal: controller.signal,
        llm: mockLlm(async () => {
          calls += 1;
          return createStopOutcome();
        }),
      }).run(runInput([{ role: "user", content: "hello" }]))))).toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });
});
