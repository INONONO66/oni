import { generationSnapshot } from "../src/core/store/configure";
import { testBus } from "./helpers/bus";
import { expect, test } from "bun:test";

import { KERNEL_POLICY_REGISTRY } from "../src/core/gate/compile";
import { Effect, Fiber, Layer } from "effect";
import { GenerationHandlers } from "../src/core/composition/compose";
import { AgentGenerationLive } from "./helpers/generation-layer";
import { ObservationSink } from "../src/core/ports/ports";
import { GenerationRawSlots, makeSessionGenerations, type GenerationBundle } from "../src/core/session/run";
import { allowAllPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";

function bundle(generation: number, closed: number[]): GenerationBundle {
  const snapshot = generationSnapshot({
    generation, revertTo: generation - 1, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: allowAllPolicy.generation,
  });
  return {
    id: { sessionId: "generation-drain", generation }, snapshot, activate: Effect.void,
    layer: Layer.mergeAll(
      AgentGenerationLive({ snapshot, policy: allowAllPolicy, definitions: [] }),
      Layer.succeed(ObservationSink, testBus()),
      Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
      Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => { closed.push(generation); }))),
    ),
  };
}

/** One captured-and-retained owner handle outside the capture scope. */
function retainedOwner(manager: Effect.Success<ReturnType<typeof makeSessionGenerations>>) {
  return Effect.scoped(Effect.gen(function* () {
    const captured = yield* manager.capture();
    const owners = yield* captured.provide(GenerationRawSlots);
    return { release: captured.retain(), pending: owners.pending };
  }));
}

test("drain refuses retained owners and retires every settled generation", () =>
  isolated(Effect.gen(function* () {
    const closed: number[] = [];
    const manager = yield* makeSessionGenerations(bundle(1, closed));
    expect(yield* manager.configure(bundle(2, closed), Effect.succeed("committed"))).toBe("committed");
    expect(closed).toEqual([1]);
    const retained = yield* retainedOwner(manager);
    try {
      expect(retained.pending()).toBe(1);
      const drained = yield* Effect.result(manager.drain);
      expect(drained).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GenerationUnsettled", sessionId: "generation-drain", generation: 2, owners: 1 },
      });
      if (drained._tag === "Failure" && drained.failure._tag === "GenerationUnsettled") {
        expect(drained.failure.message).toBe(
          "session generation-drain generation 2 has 1 live owner(s)",
        );
      }
      expect(closed).toEqual([1]);
    } finally {
      retained.release();
    }
    expect(retained.pending()).toBe(0);
    yield* manager.drain;
    expect(closed).toEqual([1, 2]);
    yield* manager.drain;
    expect(closed).toEqual([1, 2]);
    expect(yield* Effect.result(manager.capture())).toMatchObject({
      _tag: "Failure", failure: { _tag: "GenerationUnavailable", generation: 2 },
    });
  })),
);

/** Retained heap after two full collections, so dropped generation payloads are already swept. */
function retainedHeap() {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

// A retired generation keeps only a tombstone, so its built Context is unreachable;
// retaining the Context costs ~14 KB per generation even with this light test Layer.
const RETIRED_GENERATION_CEILING_BYTES = 4 * 1024;

test("retired generations keep their identity guard without retaining their Context", () =>
  isolated(Effect.gen(function* () {
    const closed: number[] = [];
    let acquired = 0;
    const counted = (generation: number) => {
      const selected = bundle(generation, closed);
      return { ...selected, layer: Layer.merge(selected.layer,
        Layer.effectDiscard(Effect.sync(() => { acquired += 1; }))) };
    };
    const manager = yield* makeSessionGenerations(counted(1));
    const before = retainedHeap();
    for (let generation = 2; generation <= 1001; generation++) {
      yield* manager.configure(counted(generation), Effect.void);
    }
    const after = retainedHeap();
    const perGeneration = (after - before) / 1000;
    console.log(`generation heap: before=${before} after=${after} perRetired=${(perGeneration / 1024).toFixed(1)}KB`);
    expect(perGeneration).toBeLessThan(RETIRED_GENERATION_CEILING_BYTES);
    expect(acquired).toBe(1001);
    expect(closed).toHaveLength(1000);
    for (const generation of [1, 501]) {
      expect(yield* Effect.result(manager.configure(counted(generation), Effect.void))).toMatchObject({
        _tag: "Failure", failure: { _tag: "GenerationUnavailable", generation },
      });
    }
    expect(yield* Effect.scoped(Effect.result(manager.capture(counted(1))))).toMatchObject({
      _tag: "Failure", failure: { _tag: "GenerationUnavailable", generation: 1 },
    });
    expect(acquired).toBe(1001);
    expect(yield* Effect.scoped(Effect.map(manager.capture(), (live) => live.id.generation))).toBe(1001);
  })),
);

// W5.2 S4: `settle` waits for live owners without flipping `stopping`, so a
// shutdown that interrupts turns first can hand a clean zero-owner state to
// the fail-fast drain. The join can only complete after the release.
test("settle awaits a retained owner and completes exactly when it releases", () =>
  isolated(Effect.gen(function* () {
    const closed: number[] = [];
    const manager = yield* makeSessionGenerations(bundle(1, closed));
    const retained = yield* retainedOwner(manager);
    expect(retained.pending()).toBe(1);
    const settling = yield* Effect.forkScoped(manager.settle);
    // Let the settle fiber run to its owner subscription before releasing.
    yield* Effect.yieldNow;
    retained.release();
    yield* Fiber.join(settling);
    expect(retained.pending()).toBe(0);
    yield* manager.drain;
    expect(closed).toEqual([1]);
  })),
);
