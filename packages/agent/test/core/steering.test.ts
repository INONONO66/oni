import type { RunInput, LlmSink as Sink } from "../../src/core/ports/llm";
import { isolated } from "../helpers/isolated";
import { bounded } from "../helpers/bounded";
import { providerFailure } from "../helpers/mock-llm";
import { createTestAgent } from "../helpers/g0-effect";
import { describe, expect, it } from "bun:test";
import { RunEvents } from "../../src/core/loop/turn";
import { stepSnapshot } from "../helpers/messages";
import { Bus } from "../helpers/bus";
import { completeModel, mockLlm, createStopOutcome } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

describe("mid-turn steering", () => {
  it("yields at a step boundary and continues on the next model call", async () => {
    let pending = true;
    const yielded: Array<boolean | undefined> = [];
    let calls = 0;
    const result = await isolated(
      createTestAgent({
        events: Bus,
        model,
        steeringPending: () => pending,
        llm: mockLlm(async (input: RunInput, sink: Sink) => {
          calls += 1;
          yielded.push(input.shouldYield?.());
          if (calls === 1) {
            pending = false;
            sink.onMessage(stepSnapshot("first", "working", "tool-calls"));
          } else sink.onMessage(stepSnapshot("second", "done", "stop"));
          return createStopOutcome();
        }),
      }).run(runInput([{ role: "user", content: "start" }])),
    );
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("done");
    expect(calls).toBe(2);
    expect(yielded).toEqual([true, false]);
  });

  it("passes no steering callback when steering is absent", async () => {
    let callback: (() => boolean) | undefined;
    await isolated(
      createTestAgent({
        events: Bus,
        model,
        llm: mockLlm(async (input: RunInput, sink: Sink) => {
          callback = input.shouldYield;
          return completeModel(input, sink);
        }),
      }).run(runInput([{ role: "user", content: "start" }])),
    );
    expect(callback).toBeUndefined();
  });

  it("keeps the same turn index when retrying the provider", async () => {
    const indices: number[] = [];
    const retry = Promise.withResolvers<void>();
    const unsubscribeTurn = Bus.subscribe(
      RunEvents.TurnStart,
      (event: {
        traceId: string;
        sessionId: string;
        time: number;
        turnIndex: number;
        agentId?: string | undefined;
        runId?: string | undefined;
        actorId?: string | undefined;
      }) => indices.push(event.turnIndex),
    );
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    let calls = 0;
    try {
      const running = isolated(
        createTestAgent({
          events: Bus,
          model,
          llm: mockLlm(async (input: RunInput, sink: Sink) => {
            calls += 1;
            return calls === 1
              ? { type: "error", error: providerFailure("transient blip", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }) }
              : completeModel(input, sink);
          }),
        }).run(runInput([{ role: "user", content: "start" }])),
      );
      await bounded(retry.promise);
      await running;
      expect(indices).toEqual([0, 0]);
    } finally {
      unsubscribeRetry();
      unsubscribeTurn();
    }
  });
});
