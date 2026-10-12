// Run with: bun run bench/index.ts
import { Effect, Result, Stream } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bench } from "tinybench";
import { L0Observation, type LedgerSession, type Message } from "@openomni/protocol";
import { materializeSession } from "../test/store/helpers/session";
import { makeObservationBus } from "../src/core/bus";
import { openCatalogStore } from "../src/core/store/catalog";
import { openSessionStore } from "../src/core/store/session-file";
import * as SessionHandleStore from "../src/core/store/fence";
import { prepareTurnCommit, seedTurnHistory } from "./seed-turn-history";

type BenchmarkResult = {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
};
const results: BenchmarkResult[] = [];

// One measurement budget for every suite. The published run measures each task
// for 100 ms after tinybench's default warm-up; BENCHMARK_BUDGET_MS shrinks both
// phases to that many milliseconds and one iteration so an emission check of the
// entry point spends its time seeding, not sampling.
const budget = Number(process.env.BENCHMARK_BUDGET_MS);
const measurement = Number.isFinite(budget)
  ? { time: budget, iterations: 1, warmupTime: budget, warmupIterations: 1 }
  : { time: 100 };

function recordResults(suite: string, bench: Bench): void {
  console.log(`\n${suite}`);
  console.table(bench.table());
  for (const task of bench.tasks) {
    const result = task.result;
    if (result.state !== "completed")
      throw new Error(`Benchmark failed: ${suite}/${task.name}`, { cause: result });
    results.push({
      name: `${suite}/${task.name}`,
      unit: "ns/op",
      value: Math.round(result.latency.mean * 1_000_000),
    });
  }
}

interface BenchStores {
  readonly kernel: SessionHandleStore.SessionKernel;
  close(): void;
}

function openBenchStores(): BenchStores {
  const session = openSessionStore(":memory:", { now: () => 1_700_000_000_000 });
  const catalog = openCatalogStore(":memory:", { now: () => 1_700_000_000_000 });
  return {
    kernel: SessionHandleStore.createSessionKernel(session, catalog),
    close() {
      session.close();
      catalog.close();
    },
  };
}

async function runSessionHydration(): Promise<void> {
  const stores = openBenchStores();
  try {
    const sessions = Array.from({ length: 100 }, (_, index) => {
      const id = `bench-session-${index}`;
      seedTurnHistory(stores.kernel, id);
      return id;
    });
    const bench = new Bench(measurement);
    let cursor = 0;
    bench.add("get-session", () => {
      stores.kernel.row(sessions[cursor++ % sessions.length] ?? "");
    });
    // Keep the historical metric key; the live reader now folds canonical turns.
    bench.add("get-messages", () => {
      stores.kernel
        .getSnapshot(sessions[cursor++ % sessions.length] ?? "", 10)
        .turns.flatMap((turn) => turn.messages);
    });
    await bench.run();
    recordResults("session-hydration", bench);
  } finally {
    stores.close();
  }
}

// #1314: the fanout benchmark measures the production observation bus — an
// Effect PubSub built by `makeObservationBus` inside a Scope — not a test
// substitute. Each subscription is acquired deterministically (`yield*`
// registers interest before any publish), and each iteration awaits a
// deferred settled by the N-th delivery: an exact signal, never a timer.

/** Typed fanout failure (review r1 M1): a short fanout throws, never hangs. */
class FanoutShortfall extends Error {
  constructor(expected: number, live: number, delivered: number, target: number) {
    super(
      `benchmark fanout shortfall: ${live}/${expected} live subscriptions, ` +
        `${delivered}/${target} deliveries`,
    );
    this.name = "FanoutShortfall";
  }
}

async function runBusFanout(): Promise<void> {
  for (const count of [10, 50, 100]) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let stamp = 0;
          const bus = yield* makeObservationBus({
            id: () => `bench-fanout-${++stamp}`,
            now: () => 1_700_000_000_000,
          });
          let handled = 0;
          let target = 0;
          let settle: (() => void) | undefined;
          let abort: ((error: Error) => void) | undefined;
          for (let index = 0; index < count; index += 1) {
            const deliveries = yield* bus.stream(L0Observation.ActionCommittedEvent);
            yield* Effect.forkScoped(
              Stream.runForEach(deliveries, () =>
                Effect.sync(() => {
                  handled += 1;
                  if (handled === target) settle?.();
                }),
              ),
            );
          }
          // Review r1 M1: the subscription count is ASSERTED, not assumed —
          // `yield*` acquired each subscription above, so the live count must
          // equal N before a single publish is measured.
          if (bus.subscriberCount() !== count) {
            throw new FanoutShortfall(count, bus.subscriberCount(), handled, target);
          }
          const bench = new Bench(measurement);
          bench.add(`${count}-subscribers`, async () => {
            const deferred = Promise.withResolvers<void>();
            target = handled + count;
            settle = () => {
              abort = undefined;
              deferred.resolve();
            };
            abort = (error) => {
              abort = undefined;
              deferred.reject(error);
            };
            bus.sink.publish(L0Observation.ActionCommittedEvent, {
              id: "fanout-configure",
              sessionId: "fanout",
              kind: "session.configure",
              revision: 1,
            });
            await deferred.promise;
          });
          // Review r1 M1: bound the N-th-delivery wait OUTSIDE the measured
          // body — a wait that makes no delivery progress between two watchdog
          // ticks rejects with the typed error (recordResults then fails the
          // run). The happy path still settles on the exact N-th delivery and
          // never touches a timer.
          let lastHandled = -1;
          const watchdog = setInterval(() => {
            if (abort === undefined) {
              lastHandled = -1;
              return;
            }
            if (handled === lastHandled) {
              abort(new FanoutShortfall(count, bus.subscriberCount(), handled, target));
              return;
            }
            lastHandled = handled;
          }, 2_000);
          try {
            yield* Effect.promise(() => bench.run());
          } finally {
            clearInterval(watchdog);
          }
          recordResults("bus-fanout", bench);
        }),
      ),
    );
  }
}

async function runMessageSerialization(): Promise<void> {
  const message: Message.Info = {
    id: "assistant-serialization-session-1",
    sessionID: "serialization-session",
    role: "assistant",
    time: { created: 1_700_000_000_001, completed: 1_700_000_000_051 },
    parentID: "message-serialization-session-1",
    modelID: "bench",
    providerID: "bench",
    agent: "bench-agent",
    path: { cwd: "/tmp/openomni", root: "/tmp/openomni" },
    tokens: { input: 512, output: 128, reasoning: 64, cache: { read: 32, write: 16 } },
    finish: "stop",
  };
  const payload = JSON.stringify(message);
  const bench = new Bench(measurement);
  bench.add("stringify-message", () => {
    JSON.stringify(message);
  });
  bench.add("parse-message", () => {
    JSON.parse(payload);
  });
  await bench.run();
  recordResults("message-serialization", bench);
}

async function runStorageSessionList(): Promise<void> {
  // Each measured task completes before its owned stores are closed.
  for (const count of [10, 100, 500]) {
    const stores = openBenchStores();
    try {
      for (let index = 0; index < count; index += 1)
        materializeSession(stores.kernel, `list-${count}-${index}`);
      const bench = new Bench(measurement);
      bench.add(`${count}-sessions`, () => {
        stores.kernel.listRows();
      });
      await bench.run();
      recordResults("storage-session-list", bench);
    } finally {
      stores.close();
    }
  }
}

async function runSessionTree(): Promise<void> {
  const stores = openBenchStores();
  try {
    const bench = new Bench({
      iterations: 5,
      warmupTime: 100,
      warmupIterations: 2,
      ...measurement,
    });
    for (const count of [1_000, 10_000]) {
      const id = `tree-${count}`;
      seedTurnHistory(stores.kernel, id, count / 2);
      bench.add(`${count / 1_000}k-actions`, () => {
        stores.kernel.getSnapshot(id, 10);
      });
    }
    await bench.run();
    recordResults("session-tree", bench);
    const history = new Bench(measurement);
    history.add("page", () => {
      stores.kernel.historyPage("tree-10000", { limit: 50 });
    });
    await history.run();
    recordResults("session-history", history);
  } finally {
    stores.close();
  }
}

async function runSessionCommit(): Promise<void> {
  const stores = openBenchStores();
  try {
    const id = "commit-session";
    seedTurnHistory(stores.kernel, id);
    const generation = stores.kernel.latestGenerationFor(id);
    let parentId = stores.kernel.latestAction(id)?.id ?? null;
    let index = 10;
    let request: LedgerSession.Commit;
    let result: Effect.Success<ReturnType<typeof stores.kernel.commit>>;
    const bench = new Bench(measurement);
    bench.add(
      "action",
      () => {
        result = Result.getOrThrowWith(
          Effect.runSync(Effect.result(stores.kernel.commit(request))),
          (error) => error,
        );
      },
      {
        beforeEach() {
          request = prepareTurnCommit(stores.kernel, id, index++, parentId, generation);
          request.actions = request.actions.slice(0, 1);
        },
        afterEach() {
          if (!result.ok) throw new Error("benchmark action commit refused", { cause: result });
          parentId = request.actions[0]?.id ?? null;
        },
      },
    );
    await bench.run();
    recordResults("session-commit", bench);
  } finally {
    stores.close();
  }
}

await runSessionHydration();
await runBusFanout();
await runMessageSerialization();
await runStorageSessionList();
await runSessionTree();
await runSessionCommit();
mkdirSync("bench-results", { recursive: true });
await Bun.write(join("bench-results", "session.json"), `${JSON.stringify(results, null, 2)}\n`);
