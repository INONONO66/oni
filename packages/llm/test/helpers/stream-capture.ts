import { beforeEach } from "bun:test";
import type { ModelMessage, ToolSet } from "ai";
import type { PlainObject } from "@openomni/protocol";
import { run, type RunInput } from "./native";
import type { StreamEvent } from "../../src/processor/stream-events";
import type { Sink } from "../../src/sink";
import { mockAiModule, streamOf, type Condition } from "./ai-mock";
import { collector } from "./observation";
import { capturingSink } from "./processor";
import { fixedNow, sequentialIds } from "./fixtures";

export type { Condition } from "./ai-mock";
interface Arguments {
  instructions?: ModelMessage[];
  messages: ModelMessage[];
  tools: ToolSet;
  toolChoice?: string;
  maxRetries: number;
  stopWhen: Condition[];
  providerOptions?: PlainObject;
  abortSignal: AbortSignal;
  onError: (payload: { error: Error }) => void;
}

export function useStreamCapture() {
  let args: Arguments | undefined;
  let stepCount: number | undefined;
  let chunks: StreamEvent[];
  const events = collector();
  beforeEach(() => {
    args = undefined;
    stepCount = undefined;
    chunks = [{ type: "finish" }];
    events.reset();
    mockAiModule<Arguments>({
      streamText: (input) => {
        args = input;
        return streamOf(chunks);
      },
      isStepCount: (count: number): Condition => {
        stepCount = count;
        return ({ steps }) => steps.length === count;
      },
    });
  });
  return {
    events,
    get args() {
      if (args === undefined) throw new Error("streamText was not called");
      return args;
    },
    condition(index: number): Condition {
      const condition = args?.stopWhen[index];
      if (condition === undefined) throw new Error(`Missing stop condition ${index}`);
      return condition;
    },
    get stepCount() {
      return stepCount;
    },
    stream(events: StreamEvent[]) {
      chunks = events;
    },
    run(overrides: Partial<RunInput> = {}, output: Sink = capturingSink().sink) {
      return run(
        {
          authFilePath: "/nonexistent/openomni-test/auth.json",
          trace: {
            traceId: "trace-stream-capture",
            sessionId: "session-stream-capture",
            runId: "run-stream-capture",
          },
          events,
          now: fixedNow,
          id: sequentialIds(),
          messages: [],
          tools: [],
          auth: { type: "api", key: "test-key-stream-capture" },
          model: {
            id: "claude-3-haiku",
            providerID: "__test_stream_capture__",
            name: "test",
            api: { npm: "@ai-sdk/anthropic" },
          },
          ...overrides,
        },
        output,
      );
    },
  };
}
