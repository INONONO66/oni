import { isolated } from "../../helpers/isolated";
import { providerFailure } from "../../helpers/mock-llm";
import { describe, expect, it } from "bun:test";
import { Operational } from "@oni/protocol";
import { RunEvents } from "../../../src/core/loop/turn";
import { runTestAgent } from "../../helpers/effect-g2";
import { bounded } from "../../helpers/bounded";
import { advanceRunTurn, createRunState, recordRunTurn } from "../../../src/core/loop/turn";
import { Bus } from "../../helpers/bus";
import { mockLlm, completeModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";
import { testMessageSource } from "../../helpers/message-source";

describe("turn budget across retries", () => {
  it("charges the same turn once and a subsequent turn once", () => {
    const state = createRunState(runInput([{ role: "user", content: "hi" }]), testMessageSource());
    recordRunTurn(state);
    recordRunTurn(state);
    expect(state.budgetState.turns).toBe(1);
    advanceRunTurn(state);
    recordRunTurn(state);
    recordRunTurn(state);
    expect(state.budgetState.turns).toBe(2);
  });

  it("reports one charged turn after a successful retry", async () => {
    let calls = 0;
    const completed = Promise.withResolvers<{ context?: { turns?: number } }>();
    const retry = Promise.withResolvers<void>();
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    const unsubscribeCompleted = Bus.subscribe(Operational.Events.Info, (event) => {
      if (event.msg === "agent.run.completed") completed.resolve(event);
    });
    try {
      const running = isolated(runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: mockLlm(async (input, sink) => {
          calls += 1;
          if (calls === 1) return { type: "error", error: providerFailure("transient provider hiccup", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } }) };
          return completeModel(input, sink);
        }),
      }));
      await bounded(retry.promise, "retry published");
      expect((await running).finishReason).toBe("stop");
      expect(calls).toBe(2);
      expect((await bounded(completed.promise, "run completed")).context?.turns).toBe(1);
    } finally {
      unsubscribeCompleted();
      unsubscribeRetry();
    }
  });
});
