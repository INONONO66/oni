import { describe, expect, it } from "bun:test";
import { Operational } from "@oni/protocol";
import { Effect } from "effect";
import { RunEvents } from "../../../src/core/loop/turn";
import { Bus } from "../../helpers/bus";
import { bounded } from "../../helpers/bounded";
import { compiledPolicy } from "../../helpers/compiled-policy";
import { failure, turnExecutor } from "../../helpers/effect-g1";
import { runTestAgent, runUserMessage } from "../../helpers/effect-g2";
import { expectUncalledBudget } from "../../helpers/execution-assertions";
import { isolated } from "../../helpers/isolated";
import { completeModel, mockLlm, countingStopLlm, createStopOutcome, providerFailure } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

function observeRunTerminals() {
  const messages: string[] = [];
  const unsubscribeInfo = Bus.subscribe(Operational.Events.Info, (event) => {
    if (event.msg.startsWith("agent.run.")) messages.push(event.msg);
  });
  const unsubscribeError = Bus.subscribe(Operational.Events.Error, (event) => {
    if (event.msg.startsWith("agent.run.")) messages.push(event.msg);
  });
  return {
    messages,
    unsubscribe: () => {
      unsubscribeError();
      unsubscribeInfo();
    },
  };
}

function awaitRunFailed() {
  const failed = Promise.withResolvers<{
    error?: string;
    context?: { reason?: string; attempt?: number; maxAttempts?: number };
  }>();
  const unsubscribe = Bus.subscribe(Operational.Events.Error, (event) => {
    if (event.msg === "agent.run.failed") failed.resolve(event);
  });
  return { promise: failed.promise, unsubscribe };
}

const timingOutLlm = mockLlm(async () => ({
  type: "error",
  error: providerFailure("connection timeout", { statusCode: 408, failureClass: { kind: "retryable", reason: "timeout", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }),
}));

describe("one terminal record per started run", () => {
  it("records ordinary completion with charged turns", async () => {
    const records = observeRunTerminals();
    const terminal = Promise.withResolvers<{ msg: string; context?: { turns?: number } }>();
    const unsubscribe = Bus.subscribe(Operational.Events.Info, (event) => {
      if (event.msg === "agent.run.completed") terminal.resolve(event);
    });
    try {
      const result = await isolated(runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        llm: mockLlm(completeModel),
      }));
      expect(result.finishReason).toBe("stop");
      expect(await bounded(terminal.promise, "run completed")).toMatchObject({
        msg: "agent.run.completed",
        context: { turns: 1 },
      });
      expect(records.messages).toEqual(["agent.run.started", "agent.run.completed"]);
    } finally {
      unsubscribe();
      records.unsubscribe();
    }
  });

  it("records budget error without invoking the model", async () => {
    const records = observeRunTerminals();
    const provider = countingStopLlm();
    try {
      const result = await isolated(Effect.flip(runUserMessage({
        events: Bus,
        model,
        budget: { maxTurns: 0 },
        llm: provider.llm,
      }, "hi")));
      expectUncalledBudget(result, provider.calls);
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      records.unsubscribe();
    }
  });

  it("records final classified retry facts at the terminal ceiling", async () => {
    const records = observeRunTerminals();
    const retries: number[] = [];
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, (event) => retries.push(event.attempt));
    const failed = awaitRunFailed();
    try {
      expect(await isolated(failure(runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        llm: timingOutLlm,
      })))).toMatchObject({ _tag: "LlmRunFailure", cause: { statusCode: 408 } });
      expect((await bounded(failed.promise, "run failed")).context).toEqual({
        reason: "timeout",
        attempt: 3,
        maxAttempts: 3,
      });
      expect(retries).toEqual([1, 2]);
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      failed.unsubscribe();
      unsubscribeRetry();
      records.unsubscribe();
    }
  });

  it("records an abort during retry backoff as an interrupt rather than provider failure", async () => {
    const records = observeRunTerminals();
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const retries: number[] = [];
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, (event) => retries.push(event.attempt));
    const failed = awaitRunFailed();
    const { executor } = turnExecutor(compiledPolicy(), [], {
      signal: controller.signal,
      retryAlarm: {
        arm: () => Effect.void,
        wait: () => Effect.sync(() => waiting.resolve()).pipe(Effect.andThen(Effect.never)),
        settle: () => Effect.void,
      },
    });
    const running = isolated(failure(runTestAgent(runInput([{ role: "user", content: "hi" }]), {
      events: Bus,
      model,
      executor,
      execution: executor,
      signal: controller.signal,
      llm: timingOutLlm,
    })));
    try {
      await bounded(waiting.promise, "retry backoff entered");
      controller.abort();
      expect(await running).toMatchObject({ _tag: "Interrupted" });
      expect((await bounded(failed.promise, "run interrupted")).context).toEqual({
        reason: "aborted",
        attempt: 1,
        maxAttempts: 3,
      });
      expect(retries).toEqual([1]);
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      controller.abort();
      await running;
      failed.unsubscribe();
      unsubscribeRetry();
      records.unsubscribe();
    }
  });

  it("records aborts without publishing a retry promise", async () => {
    const records = observeRunTerminals();
    const retries: number[] = [];
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retries.push(1));
    const controller = new AbortController();
    controller.abort();
    const failed = awaitRunFailed();
    try {
      expect(await isolated(failure(runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        signal: controller.signal,
        llm: mockLlm(async () => createStopOutcome()),
      })))).toMatchObject({ _tag: "Interrupted" });
      expect((await bounded(failed.promise, "pre-provider abort")).context?.reason).toBe("aborted");
      expect(retries).toEqual([]);
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      failed.unsubscribe();
      unsubscribe();
      records.unsubscribe();
    }
  });

  it("preserves a pre-provider non-Error terminal value", async () => {
    const records = observeRunTerminals();
    const failed = awaitRunFailed();
    const terminal = Symbol.for("terminal");
    try {
      expect(await isolated(failure(runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        llm: { resolveModel: () => Effect.die(terminal) },
      })))).toBe(terminal);
      const event = await bounded(failed.promise, "pre-provider defect");
      expect(event.error).toBe("Symbol(terminal)");
      // A defect with no failure facts publishes the machine-consumed
      // `unclassified` reason instead of an absent one.
      expect(event.context?.reason).toBe("unclassified");
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      failed.unsubscribe();
      records.unsubscribe();
    }
  });
});
