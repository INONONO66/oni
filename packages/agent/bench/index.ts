// Run with: bun run bench/index.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { Bench } from "tinybench";
import type { Message, ObservationSink } from "@oni/protocol";
import { Effect } from "effect";
import { Compaction } from "../src/plugins/compaction/compact";
import { Entropy } from "../src/core/ports/ports";
import { entropySource } from "../test/helpers/time";
import { addTurnBenchmarks, runBenchEffect } from "./turns";

/** The bench stands in for one run. It measures compaction, not reporting. */
const BENCH_TRACE = { traceId: "trace-agent-bench", sessionId: "session-agent-bench" };
const BENCH_EVENTS: ObservationSink = { publish: () => undefined };

interface BenchmarkResult {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
}

const compactionOptions = {
  contextWindowTokens: 128000,
  protectRecentMessages: 6,
};

const bench = new Bench({
  name: "Context Compaction",
  time: 100,
  warmupTime: 20,
});

for (const size of [20, 100, 500]) {
  const messages = buildMessages(size);
  bench.add(
    `compaction/${size}-messages`,
    async () => {
      await runBenchEffect(Compaction.compact(messages, compactionOptions, BENCH_TRACE, BENCH_EVENTS, {
        trigger: "threshold",
      }).pipe(Effect.provide(Entropy.layer(entropySource("bench")))));
    },
    { async: true },
  );
}

bench.add(
  "compaction/should-compact",
  () => {
    Compaction.shouldCompact(104000, compactionOptions);
  },
  { async: false },
);

addTurnBenchmarks(bench);
await bench.run();
console.table(bench.table());

const results = bench.tasks.map((task): BenchmarkResult => {
  const result = task.result;
  if (!result || !("latency" in result)) {
    throw new Error(`Benchmark did not complete: ${task.name}`);
  }

  return {
    name: task.name,
    unit: "ns/op",
    value: result.latency.mean * 1_000_000,
  };
});

mkdirSync("bench-results", { recursive: true });
writeFileSync("bench-results/agent.json", `${JSON.stringify(results, null, 2)}\n`);

function buildMessages(count: number): Message.WithParts[] {
  const sessionID = "bench-session";
  const messages: Message.WithParts[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = `message-${index}`;
    const created = 1_700_000_000_000 + index;
    const text = buildMessageText(index);
    const part: Message.TextPart = {
      id: `part-${index}`,
      sessionID,
      messageID: id,
      type: "text",
      text,
      time: { start: created, end: created + 20 },
    };

    if (index % 2 === 0) {
      messages.push({
        info: {
          id,
          sessionID,
          role: "user",
          time: { created },
          agent: "bench-user",
          model: { providerID: "bench", modelID: "synthetic" },
        },
        parts: [part],
      });
      continue;
    }

    messages.push({
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created, completed: created + 80 },
        parentID: `message-${index - 1}`,
        modelID: "synthetic",
        providerID: "bench",
        agent: "bench-agent",
        path: { cwd: "/tmp/oni", root: "/tmp/oni" },
        tokens: {
          input: 320,
          output: 180,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [part],
    });
  }

  return messages;
}

function buildMessageText(index: number): string {
  return [
    `Turn ${index} discusses a realistic project coordination update with requirements, constraints, and evidence.`,
    "The message includes enough prose to resemble an agent transcript rather than a trivial fixture.",
    "It mentions files, verification gates, implementation notes, and follow-up context for compaction.",
  ].join(" ");
}
