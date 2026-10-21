import { afterEach, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { makeLlmService } from "../src";
import { LlmOperationFailure } from "../src/errors";
import type { StreamEvent } from "../src/processor/stream-events";
import { usePrivateCatalog } from "./helpers/catalog";
import { fixedNow, sequentialIds } from "./helpers/fixtures";
import { runEffect } from "./helpers/native";

/**
 * The service the composition root binds to the core's `Llm` tag (#1352):
 * port-shaped, one provider attempt per `run`, credential path closed over
 * at construction. The tag itself is the core's; this package has none.
 */
usePrivateCatalog();
afterEach(() => mock.restore());

const AUTH_FILE = "/nonexistent/oni-test/auth.json";

test("the service resolves catalog models and preserves typed resolution failure", async () => {
  const service = makeLlmService(AUTH_FILE);
  const model = await runEffect(service.resolveModel({ provider: "anthropic", id: "fixture-claude" }, fixedNow));
  expect(model).toMatchObject({ id: "fixture-claude", providerID: "anthropic", name: "Fixture Claude" });
  expect(await runEffect(Effect.flip(service.resolveModel({ provider: "absent", id: "missing" }, fixedNow)))).toMatchObject({
    _tag: "ModelResolutionError", provider: "absent", model: "missing", reason: "provider_not_found",
  });
  const failure = new LlmOperationFailure({ operation: "transport", cause: "connection_lost" });
  expect(await runEffect(Effect.flip(failure))).toBe(failure);
  expect(failure.message).toBe("transport: connection_lost");
});

test.each([false, true])("the service runs one real processor attempt (transport failure: %s)", async (fails) => {
  let attempts = 0;
  const service = makeLlmService(AUTH_FILE);
  const outcome = await runEffect(Effect.gen(function* () {
    const model = yield* service.resolveModel({ provider: "anthropic", id: "fixture-claude" }, fixedNow);
    return yield* service.run({
      messages: [], tools: [], model,
      now: fixedNow, id: sequentialIds(),
      trace: { traceId: "layer-trace", sessionId: "layer-session", runId: "layer-run" },
      events: { publish: () => undefined },
    }, {
      onMessage: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined,
    }, {
      createStream: () => Effect.sync(() => {
        attempts += 1;
        return {
          fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
            yield { type: "step-finish", usage: { inputTokens: 17, outputTokens: 2 } };
            if (fails) throw Object.assign(new Error("overloaded"), { isRetryable: true, statusCode: 529 });
            yield { type: "finish", finishReason: "stop" };
          })(),
        };
      }),
    });
  }));

  expect(attempts).toBe(1);
  expect(outcome).toMatchObject(fails ? {
    type: "error", error: { visibleOutput: false, usage: { inputTokens: 17, outputTokens: 2 } },
  } : {
    type: "stop", evidence: { usage: { inputTokens: 17, outputTokens: 2 } },
  });
});

test("the service classifies with the package's pure classifier", () => {
  const service = makeLlmService(AUTH_FILE);
  expect(service.classifyFailure({ error: Object.assign(new Error("stop"), { name: "AbortError" }) })).toEqual({ kind: "aborted" });
  expect(service.classifyFailure({ usage: { inputTokens: 1001, outputTokens: 1 }, finishReason: "stop", contextWindow: 1000 })).toEqual({ kind: "overflow" });
});
