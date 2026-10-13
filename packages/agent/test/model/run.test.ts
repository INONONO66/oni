import { runEffect } from "./helpers/native";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LlmCall, type Message, type Tool } from "@openomni/protocol";
import { mockAiModule, streamOf, type StreamTextArgs } from "./helpers/ai-mock";
import type { StreamEvent } from "../../src/model/processor/stream-events";
import type { Sink } from "../../src/model/sink";
import { Bus, collector } from "./helpers/observation";
import { Auth } from "../../src/model/auth";
import type { Provider } from "../../src/model/provider";
import { newTraceId } from "./helpers/observation";
import { sdkError } from "./helpers/retry";

const TEST_TRACE = { traceId: newTraceId(), sessionId: "session-test", runId: "run-test" };

type RunModule = typeof import("./helpers/native");
let run: RunModule["run"];

let capturedStreamArgs: StreamTextArgs | undefined;

let mockStreamChunks: StreamEvent[] = [{ type: "finish" }];

function mockCapturingAi(): void {
  mockAiModule({
    streamText: (args: StreamTextArgs) => {
      capturedStreamArgs = args;
      return streamOf(mockStreamChunks);
    },
  });
}

mockCapturingAi();

const testAuth = { type: "api", key: "test-key-run" } as const;
const testModel: Provider.Model = {
  id: "claude-3-haiku",
  providerID: "__test_run__",
  name: "Claude 3 Haiku Test",
  api: { npm: "@ai-sdk/anthropic" },
};

describe("run", () => {
  let mockSink: Sink;
  let capturedMessages: Message.WithParts[];
  let capturedToolCalls: Tool.Call[];
  let capturedToolResults: Tool.Result[];

  beforeAll(async () => {
    ({ run } = await import("./helpers/native"));
  });

  beforeEach(() => {
    mockStreamChunks = [{ type: "finish" }];
    mockCapturingAi();
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    capturedStreamArgs = undefined;

    mockSink = {
      onMessage: (message: Message.WithParts) => {
        capturedMessages.push(message);
      },
      onToolCall: (call: Tool.Call) => {
        capturedToolCalls.push(call);
      },
      onToolResult: (result: Tool.Result) => {
        capturedToolResults.push(result);
      },
    };
  });

  afterEach(() => {
    capturedStreamArgs = undefined;
  });

  test("returns RunOutcome with stop type", async () => {
    const input: import("./helpers/native").TestRunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("stop");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("handles abort signal", async () => {
    const abortController = new AbortController();
    const input: import("./helpers/native").TestRunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
      signal: abortController.signal,
    };

    abortController.abort();

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("returns error outcome when auth is not configured", async () => {
    const input: import("./helpers/native").TestRunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: {
        id: "claude-3-haiku",
        providerID: "no-auth-provider-xyz",
        name: "Test Model",
        api: { npm: "@ai-sdk/anthropic" },
      },
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("error");
    if (outcome.type === "error") {
      expect(outcome.error.message).toContain("no-auth-provider-xyz");
    }
    expect(capturedToolCalls.length).toBe(0);
  });

  test("preserves typed terminal provider facts in the error outcome", async () => {
    const source = sdkError({
      message: "opaque provider failure",
      isRetryable: false,
      statusCode: 400,
      responseHeaders: { "retry-after-ms": "1234" },
    });
    mockStreamChunks = [
      { type: "finish-step", finishReason: "error", usage: { inputTokens: 17, outputTokens: 5 } },
      { type: "error", error: source },
    ];

    const outcome = await run(
      { trace: TEST_TRACE, events: Bus, messages: [], tools: [], model: testModel, auth: testAuth },
      mockSink,
    );

    expect(outcome).toMatchObject({
      type: "error",
      error: {
        _tag: "LlmRunFailure",
        retryAfterMs: 1_234,
        usage: { inputTokens: 17, outputTokens: 5 },
        aborted: false,
        cause: {
          statusCode: 400,
          isRetryable: false,
          responseHeaders: { "retry-after-ms": "1234" },
        },
      },
    });
  });

  test("preserves a provider abort fact in the aborted outcome", async () => {
    const source = Object.assign(new Error("provider cancelled"), { name: "AbortError" });
    mockStreamChunks = [{ type: "error", error: source }];

    const outcome = await run(
      { trace: TEST_TRACE, events: Bus, messages: [], tools: [], model: testModel, auth: testAuth },
      mockSink,
    );

    expect(outcome.type).toBe("aborted");
    if (outcome.type !== "aborted") throw new Error("expected an aborted outcome");
    expect(outcome.error?.aborted).toBe(true);
    // The abort source rides the failure structurally.
    expect(outcome.error?.cause).toBe(source);
  });

  test("publishes LlmCall.Events.Failed on error so every Started call terminates", async () => {
    const failures: Array<{ readonly error: string; readonly traceId: string }> = [];
    let observeFailure!: () => void;
    const failureObserved = new Promise<void>((resolve) => {
      observeFailure = resolve;
    });
    const unsub = Bus.subscribe(LlmCall.Events.Failed, (event) => {
      failures.push(event);
      observeFailure();
    });

    const outcome = await run(
      {
        messages: [],
        tools: [],
        model: {
          id: "claude-3-haiku",
          providerID: "no-auth-provider-failed-event",
          name: "Test Model",
          api: { npm: "@ai-sdk/anthropic" },
        },
        trace: { traceId: "trace-run-failed", sessionId: "session-failed", runId: "run-failed" },
        events: Bus,
      },
      mockSink,
    );
    await failureObserved;
    unsub();

    expect(outcome.type).toBe("error");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      traceId: "trace-run-failed",
      aborted: false,
    });
    expect(failures[0]?.error).toContain("no-auth-provider-failed-event");
  });

  test("does not read stored auth when fallback is disabled", async () => {
    const authFile = join(mkdtempSync(join(tmpdir(), "openomni-run-auth-")), "auth.json");

    try {
      await runEffect(Auth.set("stored-auth-provider", testAuth, { id: () => "tmp-stored", authFilePath: authFile }));

      const outcome = await run(
        {
          trace: TEST_TRACE,
          events: Bus,
          messages: [],
          tools: [],
          allowAuthFallback: false,
          authFilePath: authFile,
          model: {
            id: "claude-3-haiku",
            providerID: "stored-auth-provider",
            name: "Test Model",
            api: { npm: "@ai-sdk/anthropic" },
          },
        },
        mockSink,
      );

      expect(outcome.type).toBe("error");
      expect(capturedStreamArgs).toBeUndefined();
    } finally {
      rmSync(authFile, { force: true });
    }
  });

  test("returns aborted outcome when signal is aborted before run", async () => {
    const controller = new AbortController();
    controller.abort();

    const input: import("./helpers/native").TestRunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
      signal: controller.signal,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
    expect(capturedStreamArgs).toBeUndefined();
  });

  test("calls sink methods during execution", async () => {
    const input: import("./helpers/native").TestRunInput = {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      model: testModel,
      auth: testAuth,
    };

    await run(input, mockSink);

    expect(capturedMessages.length).toBeGreaterThan(0);
    expect(capturedToolCalls.length).toBe(0);
  });

  test("v6 text block yields exactly one non-empty text part (no v4 shim duplicates)", async () => {
    // Real ai-sdk v6 fullStream shape: explicit text-start/text-end frame the deltas.
    // The removed v4 shim synthesized a second text-start on the first delta,
    // leaving an orphan empty text part per block — this asserts that never returns.
    mockStreamChunks = [
      { type: "start-step" },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", text: "hello " },
      { type: "text-delta", id: "txt_1", text: "world" },
      { type: "text-end", id: "txt_1" },
      { type: "finish-step" },
      { type: "finish" },
    ];
    mockCapturingAi();

    const outcome = await run(
      {
        trace: TEST_TRACE,
        events: Bus,
        messages: [],
        tools: [],
        model: testModel,
        auth: testAuth,
      },
      mockSink,
    );

    expect(outcome.type).toBe("stop");
    const lastMessage = capturedMessages.at(-1);
    expect(lastMessage).toBeDefined();
    const textParts = (lastMessage?.parts ?? []).filter((part) => part.type === "text");
    expect(textParts.length).toBe(1);
    expect(textParts[0]?.text).toBe("hello world");
    expect(textParts.some((part) => part.text === "")).toBe(false);
  });

  test("a failed single attempt retains billing and a subsequent invocation reports its own usage", async () => {
    // Regression (#audit M3): Completed read processor.message.tokens — the
    // final attempt's fold — so a retried attempt's billed usage vanished
    // from telemetry.
    let call = 0;
    mockAiModule({
      streamText: () => {
        call++;
        return streamOf(
          call === 1
            ? [
                {
                  type: "finish-step",
                  finishReason: "stop",
                  usage: { inputTokens: 100, outputTokens: 40 },
                },
                {
                  type: "error",
                  error: Object.assign(new Error("overloaded"), {
                    isRetryable: true,
                    statusCode: 529,
                    responseHeaders: { "retry-after-ms": "1" },
                  }),
                },
              ]
            : [
                {
                  type: "finish-step",
                  finishReason: "stop",
                  usage: { inputTokens: 200, outputTokens: 60 },
                },
                { type: "finish" },
              ],
        );
      },
      isStepCount: () => () => false,
    });

    const collected = collector();
    const outcome = await run(
      {
        trace: TEST_TRACE,
        events: collected,
        messages: [],
        tools: [],
        model: testModel,
        auth: testAuth,
      },
      mockSink,
    );

    expect(outcome).toMatchObject({
      type: "error",
      error: { usage: { inputTokens: 100, outputTokens: 40 } },
    });
    expect(call).toBe(1);
    const second = await run(
      {
        trace: TEST_TRACE,
        events: collected,
        messages: [],
        tools: [],
        model: testModel,
        auth: testAuth,
      },
      mockSink,
    );
    expect(second.type).toBe("stop");
    expect(call).toBe(2);
    const completed = collected.named(LlmCall.Events.Completed.name) as Array<{
      inputTokens: number;
      outputTokens: number;
    }>;
    expect(completed).toHaveLength(1);
    expect(completed[0]?.inputTokens).toBe(200);
    expect(completed[0]?.outputTokens).toBe(60);
  });

  /**
   * The point of the port. `llm` reports what it did to whatever the caller
   * hands it — no process-wide `Bus`, nothing to reset between tests, and P2
   * can put a fail-closed ledger append behind this without touching `run()`.
   */
  test("reports through the injected sink, not a global bus", async () => {
    const collected = collector();
    const globalPublish = spyOn(Bus, "publish");

    try {
      await run(
        {
          messages: [],
          tools: [],
          model: testModel,
          auth: testAuth,
          trace: TEST_TRACE,
          events: collected,
        },
        mockSink,
      );

      expect(collected.named(LlmCall.Events.Started.name)).toHaveLength(1);
      // Every `Started` gets a terminal event — the success half of the pair the
      // failure test covers.
      expect(collected.named(LlmCall.Events.Completed.name)).toHaveLength(1);
      expect(globalPublish).not.toHaveBeenCalled();
    } finally {
      globalPublish.mockRestore();
    }
  });

  /**
   * The failure path publishes three of the eight records, and the happy path
   * never reaches it — so without this the port is unpinned there.
   */
  test("reports a failed call through the injected sink too", async () => {
    const collected = collector();
    const globalPublish = spyOn(Bus, "publish");

    try {
      const outcome = await run(
        {
          messages: [],
          tools: [],
          model: {
            id: "claude-3-haiku",
            providerID: "no-auth-provider-port-test",
            name: "Test Model",
            api: { npm: "@ai-sdk/anthropic" },
          },
          trace: TEST_TRACE,
          events: collected,
        },
        mockSink,
      );
      expect(outcome.type).toBe("error");
      expect(collected.named(LlmCall.Events.Started.name)).toHaveLength(1);
      expect(collected.named(LlmCall.Events.Failed.name)).toHaveLength(1);
      expect(globalPublish).not.toHaveBeenCalled();
    } finally {
      globalPublish.mockRestore();
    }
  });

  /**
   * Refused at the boundary rather than half-dropped: an empty trace used to
   * silence the processor's records while `run` kept publishing malformed
   * ones, which displaces the wrong-kind defect instead of closing it.
   */
  test.each([
    ["traceId", { traceId: "", sessionId: "s", runId: "r" }],
    ["sessionId", { traceId: "t", sessionId: "", runId: "r" }],
    // The docstring always claimed a call "that cannot name its run" is
    // refused; the guard only checked traceId/sessionId, so an empty runId
    // sailed through into every LlmCall event.
    ["runId", { traceId: "t", sessionId: "s", runId: "" }],
  ])("refuses an empty %s", async (_field, trace) => {
    await expect(
      run(
        { messages: [], tools: [], model: testModel, auth: testAuth, trace, events: collector() },
        mockSink,
      ),
    ).rejects.toThrow("llm run requires a non-empty traceId, sessionId, and runId");
  });
});
