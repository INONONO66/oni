import { Effect } from "effect";
import { describe, expect, it } from "bun:test";
import { Core } from "@openomni/agent";
const Llm = Core.Llm;
const ObservationSink = Core.ObservationSink;
import { Bus } from "./helpers/bus";
import type { FixtureLlm } from "./helpers/app-fixture";
import { fakeLlm } from "../../../packages/agent/test/helpers/fake-llm";
const LlmRunFailure = Core.LlmRunFailure;
import type { Message } from "@openomni/protocol";
import {
  createCompactionSummarizer as summarizer,
  SummarizerError,
} from "../src/compaction/summarizer";
const ExecutorContext = Core.ExecutorContext;
import { executor } from "./helpers/executor";
import { runEffect, runSyncEffect } from "./helpers/effect";
import { testIds } from "./helpers/test-entropy";

function createCompactionSummarizer(config: Parameters<typeof summarizer>[0] & { readonly io: Partial<FixtureLlm> }) {
  const run = runSyncEffect(summarizer(config).pipe(Effect.provideService(Llm, fakeLlm(config.io)), Effect.provideService(ObservationSink, Bus)));
  return (...args: Parameters<typeof run>) => Effect.provideService(run(...args), ExecutorContext, executor);
}

const MODEL = { provider: "fake", id: "summary-model", apiKey: "key" };
const BUDGET = { contextWindowTokens: 100_000, maxInputTokens: 50_000, maxOutputTokens: 20_000 };

function message(id: string, text: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "session",
      role: "assistant",
      time: { created: 1 },
      parentID: "parent",
      modelID: "summary-model",
      providerID: "fake",
      agent: "resident",
      path: { cwd: "", root: "" },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [{ id: `${id}-part`, sessionID: "session", messageID: id, type: "text", text }],
  };
}

function answer(text: string): Message.WithParts {
  return message("answer", text);
}

const resolveModel: NonNullable<FixtureLlm["resolveModel"]> = (model) => Effect.succeed({
  id: model.id,
  name: model.id,
  providerID: model.provider,
});

function runFailure(contextOverflow: boolean, message: string): Core.LlmRunFailure {
  return new LlmRunFailure({
    visibleOutput: false,
    message,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    aborted: false,
    contextOverflow,
  });
}

function failingRun(failure: Core.LlmRunFailure, onCall: (input: Parameters<NonNullable<FixtureLlm["run"]>>[0]) => void): NonNullable<FixtureLlm["run"]> {
  return (input) => Effect.sync(() => {
    onCall(input);
    return { type: "error", error: failure };
  });
}

async function expectSummarizerFailure(
  run: NonNullable<FixtureLlm["run"]>,
  spans: Message.WithParts[],
  kind: "empty" | "overflow",
): Promise<void> {
  const summarize = createCompactionSummarizer({ model: MODEL, now: () => 1000, id: testIds("summarizer"), io: { run, resolveModel } });
  const error = await runEffect(Effect.flip(summarize(spans, undefined, BUDGET)));
  expect(error).toBeInstanceOf(SummarizerError);
  expect(error).toMatchObject({ _tag: "AgentFailure", kind });
}

describe("production compaction summarizer", () => {
  it("merges the previous anchor without tools and bounds output tokens", async () => {
    let captured: Parameters<NonNullable<FixtureLlm["run"]>>[0] | undefined;
    const run: NonNullable<FixtureLlm["run"]> = (input, sink) => Effect.sync(() => {
      captured = input;
      sink.onMessage(answer("dense merged summary"));
      return { type: "stop" };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, now: () => 1000, id: testIds("summarizer"), io: { run, resolveModel } });

    await expect(runEffect(summarize([message("m1", "new span")], "prior anchor", BUDGET))).resolves.toBe(
      "dense merged summary",
    );
    expect(captured?.tools).toEqual([]);
    expect(captured?.toolChoice).toBe("none");
    expect(captured?.maxTokens).toBe(20_000);
    expect(captured?.providerOptions).toEqual({ openai: { reasoningEffort: "minimal" } });
    const prompt = captured?.messages[0]?.parts[0];
    expect(prompt?.type === "text" ? prompt.text : "").toContain("prior anchor");
  });

  it("throws a typed empty error for an empty model response", async () => {
    const run: NonNullable<FixtureLlm["run"]> = (_input, sink) => Effect.sync(() => {
      sink.onMessage(answer("   "));
      return { type: "stop" };
    });
    await expectSummarizerFailure(run, [message("m1", "span")], "empty");
  });

  it("uses the typed overflow flag to shrink twice before a typed overflow error", async () => {
    const inputLengths: number[] = [];
    const failure = runFailure(true, "opaque upstream failure");
    const run = failingRun(failure, (input) => { inputLengths.push(input.messages.length); });
    await expectSummarizerFailure(
      run,
      [message("m1", "oldest"), message("m2", "middle"), message("m3", "newest")],
      "overflow",
    );
    expect(inputLengths).toEqual([4, 3, 2]);
  });

  it("does not retry overflow prose when the typed flag is false", async () => {
    let calls = 0;
    const failure = runFailure(false, "context window has been exceeded");
    const run = failingRun(failure, () => { calls += 1; });
    const summarize = createCompactionSummarizer({ model: MODEL, now: () => 1000, id: testIds("summarizer"), io: { run, resolveModel } });

    const error = await runEffect(Effect.flip(summarize([message("m1", "span")], undefined, BUDGET)));
    expect(calls).toBe(1);
    expect(error).toBe(failure);
  });

  it.each([false, true])("surfaces an aborted run as Interrupted (pre-aborted=%s)", async (preAborted) => {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    let calls = 0;
    const run: NonNullable<FixtureLlm["run"]> = (input) => Effect.sync(() => {
      calls += 1;
      expect(input.signal).toBe(controller.signal);
      return { type: "aborted" };
    });
    const summarize = createCompactionSummarizer({ model: MODEL, now: () => 1000, id: testIds("summarizer"), io: { run, resolveModel } });

    const error = await runEffect(Effect.flip(summarize(
      [message("m1", "span")],
      undefined,
      BUDGET,
      controller.signal,
    )));
    expect(error).toMatchObject({ _tag: "Interrupted" });
    expect(calls).toBe(preAborted ? 0 : 1);
    expect(error).not.toBeInstanceOf(SummarizerError);
  });
});
