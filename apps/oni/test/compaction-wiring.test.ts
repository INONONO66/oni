import { Effect } from "effect";
import { Core } from "@oni/agent";
import { LlmLive } from "../src/runtime";
const ObservationSink = Core.ObservationSink;
import { Bus, newTraceId } from "./helpers/bus";
import { runSyncEffect } from "./helpers/effect";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import { loadConfig } from "../src/config";
import { compactionOptions } from "../src/bundles/compaction/index";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { planeOf } from "./helpers/ledger";
import { testIds } from "./helpers/test-entropy";

const KEYS = [
  "ONI_MODEL_PROVIDER",
  "ONI_MODEL_ID",
  "ONI_MODEL_API_KEY",
  "ONI_COMPACTION_SUMMARIZER",
] as const;
let saved: Record<string, string | undefined>;
const suite = residentSuite();

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.ONI_MODEL_PROVIDER = "fake";
  process.env.ONI_MODEL_ID = "resident-test";
  process.env.ONI_MODEL_API_KEY = "test-key";
  delete process.env.ONI_COMPACTION_SUMMARIZER;
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("compaction composition configuration", () => {
  it("wires a run-scoped summarizer by default", () => {
    expect(runSyncEffect(compactionOptions(loadConfig(), { now: () => 1000, id: testIds("compaction"), sessionId: "session", system: "system" }).pipe(Effect.provide(LlmLive), Effect.provideService(ObservationSink, Bus))).onSummarize).toBeFunction();
  });

  it("omits the summarizer when explicitly off; elision stays the plugin's default", () => {
    process.env.ONI_COMPACTION_SUMMARIZER = "off";
    const compaction = runSyncEffect(compactionOptions(loadConfig(), { now: () => 1000, id: testIds("compaction"), sessionId: "session", system: "system" }).pipe(Effect.provide(LlmLive), Effect.provideService(ObservationSink, Bus)));
    expect(compaction.onSummarize).toBeUndefined();
    expect(compaction.elideToolOutputs).toBeUndefined();
  });
  it("passes configured compaction through the production Resident root", async () => {
    const config = suite.config("oni-root-compaction-", {
      wsToken: "root-compaction-token",
      compactionSummarizer: false,
    });
    const messageCounts: number[] = [];
    let constrained = false;
    let calls = 0;
    const app = await suite.boot({
      config,
      llm: {
        resolveModel: (model) => fakeProviderModel(model).pipe(Effect.map((resolved) => ({
          ...resolved,
          limit: { context: constrained ? 700 : 100_000 },
        }))),
        run: (input: RunInput, sink: Sink) => Effect.sync(() => {
          calls += 1;
          if (constrained) messageCounts.push(input.messages.length);
          sink.onMessage(
            assistantMessage(input, {
              call: calls,
              reason: constrained && messageCounts.length === 1 ? "tool-calls" : "stop",
              text: `answer ${calls} ${"filler ".repeat(30)}`,
              tokens: constrained
                ? { input: 650, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
                : undefined,
            }),
          );
          return { type: "stop" as const };
        }),
      },
    });
    const plane = await planeOf(app.runtime);
    const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, [
      "auth",
      "root-compaction-token",
    ]);
    for (let index = 0; index < 6; index += 1) {
      const reply = nextResidentTurn(plane);
      ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: `seed ${index} ${"filler ".repeat(30)}` }));
      await reply;
    }
    constrained = true;
    const reply = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "compact now" }));
    await reply;

    expect(messageCounts).toHaveLength(2);
    expect(messageCounts[1]).toBeLessThan(messageCounts[0] ?? 0);
  }, 60_000); // instrumented: ~6 real SSE turns through the production root
});
