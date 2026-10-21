import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent, failure as effectFailure } from "../helpers/effect-g2";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type FailureClass,
  type FailureFacts,
  Llm,
  LlmRunFailure,
  type LlmPort,
  type RunInput,
  type LlmSink,
} from "../../src/core/ports/llm";
import type { Model } from "@oni/protocol";
import { RunEvents } from "../../src/core/loop/turn";
import { Bus } from "../helpers/bus";
import { runInput } from "../helpers/run-input";
import { FakeProviderError } from "../helpers/fake-llm";
import { createAssistantMessage } from "../../src/core/journal/message-factory";
import { messageSource } from "../helpers/message-source";
import { failureFacts } from "../../src/core/loop/retry";

/**
 * The reversed dependency (#1352): the core declares the `Llm` port and
 * reads a failed call only through the port's closed `FailureClass`. These
 * tests script the verdict directly, so what they prove is that the loop's
 * decision follows the verdict and never the error object behind it.
 */
afterEach(() => Bus.reset());

const usage = { inputTokens: 40, outputTokens: 3, reasoningTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 };
const CONTEXT_WINDOW = 1000;

interface Scripted {
  readonly facts: FailureFacts[];
  calls: number;
  readonly retries: { reason: string; backoffMs: number }[];
}

function scriptedPort(
  verdict: FailureClass,
  failing: (call: number) => boolean,
  stop: (call: number) => { readonly visibleOutput: boolean } | undefined = () => undefined,
): { port: LlmPort; observed: Scripted } {
  const observed: Scripted = { facts: [], calls: 0, retries: [] };
  const port: LlmPort = {
    resolveModel: (model: Model.Ref) =>
      Effect.succeed({ id: model.id, name: model.id, providerID: model.provider, limit: { context: CONTEXT_WINDOW, output: 100 } }),
    run: (input: RunInput, sink: LlmSink) =>
      Effect.sync(() => {
        observed.calls += 1;
        const evidence = stop(observed.calls);
        if (evidence !== undefined) {
          const parentID = input.messages.at(-1)?.info.id ?? "";
          const message = createAssistantMessage(evidence.visibleOutput ? "shown" : "", parentID, input.trace.sessionId, messageSource);
          sink.onMessage(evidence.visibleOutput ? message : { ...message, parts: [] });
          return {
            type: "stop" as const,
            evidence: { usage: { ...usage, inputTokens: CONTEXT_WINDOW + 1 }, visibleOutput: evidence.visibleOutput, finishReason: "stop", credential: null },
          };
        }
        if (failing(observed.calls)) {
          const cause = new FakeProviderError({ message: "provider said no", statusCode: 529, isRetryable: true });
          return {
            type: "error" as const,
            error: new LlmRunFailure({
              message: cause.message, cause, providerErrorName: cause.name,
              usage, aborted: false, contextOverflow: false, visibleOutput: false,
            }),
          };
        }
        sink.onMessage(createAssistantMessage("done", input.messages.at(-1)?.info.id ?? "", input.trace.sessionId, messageSource));
        return { type: "stop" as const };
      }),
    classifyFailure: (facts) => {
      observed.facts.push(facts);
      return verdict;
    },
  };
  return { port, observed };
}

function run(port: LlmPort, observed: Scripted) {
  const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, (event) => {
    observed.retries.push({ reason: event.reason, backoffMs: event.backoffMs });
  });
  const agent = createTestAgent({
    events: Bus,
    model: { provider: "scripted", id: "scripted-model" },
    auth: { type: "api", key: "test-key" },
    llm: port,
  });
  return {
    succeed: () => isolated(agent.run(runInput([{ role: "user", content: "go" }]))).finally(unsubscribe),
    fail: () => isolated(effectFailure(agent.run(runInput([{ role: "user", content: "go" }])))).finally(unsubscribe),
  };
}

describe("the core llm port", () => {
  it("keeps the binding key the composition root has always bound", () => {
    expect(Llm.key).toBe("@oni/agent/Llm");
  });

  it("hands the port the attempt's own facts: the failure, its billed usage, the resolved window and the clock", async () => {
    const { port, observed } = scriptedPort(
      { kind: "retryable", reason: "transient_error", providerReason: "overloaded", instant: false },
      (call) => call === 1,
    );
    const result = await run(port, observed).succeed();
    expect(result.finishReason).toBe("stop");
    expect(observed.calls).toBe(2);
    expect(observed.facts).toHaveLength(1);
    const facts = observed.facts[0];
    expect(facts?.error).toBeInstanceOf(LlmRunFailure);
    expect(facts?.usage).toEqual(usage);
    expect(facts?.contextWindow).toBe(CONTEXT_WINDOW);
    expect(typeof facts?.now).toBe("number");
  });

  it("retries on the port's retryable verdict with the directed wait the port named", async () => {
    const { port, observed } = scriptedPort(
      { kind: "retryable", reason: "transient_error", providerReason: "rate_limit", afterMs: 7000, directed: true, instant: false },
      (call) => call === 1,
    );
    await run(port, observed).succeed();
    // The run event carries the attempt reason; the provider reason stays inside the decision.
    expect(observed.retries).toEqual([{ reason: "transient_error", backoffMs: 7000 }]);
  });

  it("stops on the port's terminal verdict without a second call, whatever the error object claims", async () => {
    // The error carries a retryable 529; the loop never looks at it (#1352).
    const { port, observed } = scriptedPort(
      { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 },
      () => true,
    );
    const error = await run(port, observed).fail();
    expect(error).toBeInstanceOf(LlmRunFailure);
    expect(observed.calls).toBe(1);
    expect(observed.retries).toEqual([]);
  });

  it("asks the port about a stop that showed nothing and treats its overflow verdict as a context_overflow failure", async () => {
    const { port, observed } = scriptedPort({ kind: "overflow" }, () => false, () => ({ visibleOutput: false }));
    const error = await run(port, observed).fail();
    expect(error).toBeInstanceOf(LlmRunFailure);
    expect(observed.calls).toBe(1);
    // First the stop's own facts without an error, then the failure it became when the attempt settled.
    expect(observed.facts[0]).toEqual({ usage: { ...usage, inputTokens: CONTEXT_WINDOW + 1 }, finishReason: "stop", contextWindow: CONTEXT_WINDOW });
    expect(observed.facts[1]).toMatchObject({ error });
    expect(failureFacts(error)).toMatchObject({ reason: "context_overflow", attempt: 1 });
  });

  it("never replays a stop that already showed output, whatever its usage says", async () => {
    const { port, observed } = scriptedPort({ kind: "overflow" }, () => false, () => ({ visibleOutput: true }));
    const result = await run(port, observed).succeed();
    expect(result.finishReason).toBe("stop");
    expect(observed.calls).toBe(1);
    expect(observed.facts).toEqual([]);
  });

  it("routes the port's overflow verdict to compaction, never the retry ladder: without a producer it is terminal after one call", async () => {
    const { port, observed } = scriptedPort({ kind: "overflow" }, () => true);
    const error = await run(port, observed).fail();
    expect(error).toBeInstanceOf(LlmRunFailure);
    expect(observed.calls).toBe(1);
    expect(observed.retries).toEqual([]);
    expect(failureFacts(error)).toMatchObject({ reason: "context_overflow", attempt: 1 });
  });
});
