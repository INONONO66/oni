import { Effect } from "effect";
import type { LlmRunFailure } from "../../../src/core/ports/llm";
import { isolated } from "../../helpers/isolated";
import { failure as failed } from "../../helpers/g0-signals";
import { describe, expect, it } from "bun:test";
import { runTestAgent } from "../../helpers/g0-effect";
import { failureFacts } from "../../../src/core/loop/retry";
import { Bus } from "../../helpers/bus";
import { providerFailure, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

async function failedRun(failure: LlmRunFailure) {
  let calls = 0;
  const result = await isolated(
    failed(
      runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: mockProviderModel.id },
        llm: {
          resolveModel: () => Effect.succeed(mockProviderModel),
          run: () =>
            Effect.suspend(() => {
              calls += 1;
              return Effect.fail(failure);
            }),
        },
      }),
    ),
  );
  return { result, calls };
}

describe("terminal failure facts", () => {
  it("carries canonical classification, spent attempts and ceiling", async () => {
    const failure = providerFailure("opaque failure", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } });
    const { result, calls } = await failedRun(failure);
    expect(result).toBe(failure);
    expect(calls).toBe(3);
    expect(failureFacts(result)).toEqual({
      reason: "transient_error",
      attempt: 3,
      maxAttempts: 3,
      llm: true,
    });
  });
  it("keeps nonretryable provider failures at one attempt", async () => {
    const { result, calls } = await failedRun(
      providerFailure("invalid request", { retryable: false, statusCode: 400, failureClass: { kind: "terminal", reason: "validation_error", providerReason: "non_retryable", status: 400 } }),
    );
    expect(calls).toBe(1);
    expect(failureFacts(result)).toEqual({
      reason: "validation_error",
      attempt: 1,
      maxAttempts: 3,
      llm: true,
    });
  });
  it("does not add enumerable provenance or change the provider error identity", async () => {
    const failure = providerFailure("failure", { failureClass: { kind: "retryable", reason: "transient_error", providerReason: "server_error", afterMs: 0, directed: true, instant: false } });
    const original = JSON.stringify(failure);
    expect((await failedRun(failure)).result).toBe(failure);
    expect(JSON.stringify(failure)).toBe(original);
    expect(
      Object.getOwnPropertyDescriptor(failure, Symbol.for("openomni.agent.failureFacts"))
        ?.enumerable,
    ).toBe(false);
  });
  it("does not attribute catalog, policy, storage or unrelated failures to the provider", async () => {
    const failure = new Error("catalog invariant failed");
    const result = await isolated(
      failed(
        runTestAgent(runInput([{ role: "user", content: "hi" }]), {
          events: Bus,
          model: { provider: "anthropic", id: "model" },
          llm: {
            resolveModel: () => Effect.die(failure),
          },
        }),
      ),
    );
    expect(result).toBe(failure);
    expect(failureFacts(result)).toBeUndefined();
    expect(failureFacts(undefined)).toBeUndefined();
    expect(failureFacts("non-Error")).toBeUndefined();
  });
});
