import { Effect } from "effect";
import { makeLlmService } from "../../src";
import { decodeLlmFailure } from "../../src/error";
import type { Processor } from "../../src/processor";
import type { RunInput } from "../../src/run";
import { sequentialIds } from "../helpers/fixtures";
import { capturingSink, streamOf, textEvents } from "../helpers/processor";
import { runEffect } from "../helpers/native";

export const connectionRefused = () => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
export const failed = (error: Error) => Effect.try({
  try: () => { throw error; },
  catch: decodeLlmFailure("test.stream"),
});
export const success: Processor.ProcessorOptions["createStream"] = (input) => Effect.tryPromise({
  try: () => streamOf([...textEvents("first", " second"), { type: "finish" }])(input),
  catch: decodeLlmFailure("test.stream"),
});

export function harness(options?: Parameters<typeof makeLlmService>[2]) {
  let time = 0;
  let calls = 0;
  const capture = capturingSink();
  const service = makeLlmService("/nonexistent/router/auth.json", [
    { id: "proxy", npm: "@ai-sdk/openai" },
    { id: "direct", npm: "@ai-sdk/openai" },
  ], options ?? {
    chains: [{ primary: "proxy/x", selectors: ["proxy/x", "direct/x"], nearestFallback: "small" }],
    credentials: [
      { provider: "proxy", auth: { type: "api", key: "primary" } },
      { provider: "direct", auth: { type: "api", key: "fallback" } },
    ],
  });
  const input: RunInput = {
    messages: [], tools: [], model: { id: "x", providerID: "proxy", name: "x" },
    now: () => time, id: sequentialIds(),
    trace: { traceId: "trace", sessionId: "session", runId: "turn" },
    events: { publish: () => undefined },
  };
  return {
    service, input, capture,
    get calls() { return calls; },
    advance: (milliseconds: number) => { time += milliseconds; },
    run: (createStream: Processor.ProcessorOptions["createStream"]) => runEffect(service.run(input, capture.sink, {
      createStream: (request) => { calls += 1; return createStream(request); },
    })),
  };
}
