import { testBus } from "./helpers/bus";
import { isolated } from "./helpers/isolated";
import { runAgentSync } from "./helpers/executor";
import { expect, test } from "bun:test";
import * as SessionHandleStore from "../src/core/store/fence";
import { compilePolicySnapshot, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "../src/core/gate/compile";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { makeSessionGenerations, GenerationRawSlots } from "../src/core/session/run";
import { SessionLayer, ToolCatalog, ObservationSink } from "../src/core/ports/ports";
import { GenerationHandlers } from "../src/core/composition/compose";

function generation(number: number, close: () => void) {
  const snapshot = SessionHandleStore.generationSnapshot({ generation: number, revertTo: number - 1,
    tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1 });
  return {
    id: { sessionId: "retirement", generation: number }, snapshot, activate: Effect.void,
    layer: Layer.mergeAll(
      Layer.succeed(SessionLayer, { snapshot, policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
        generation: 1, rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })) }) }),
      Layer.succeed(ToolCatalog, { definitions: [] }), Layer.succeed(ObservationSink, testBus()),
      Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
      Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(close))),
    ),
  };
}

test("root scope does not finalize a generation before physical raw settlement", () => isolated(Effect.scoped(Effect.gen(function* () {
  const root = yield* Scope.make();
  let rawSettled = false;
  const closed: boolean[] = [];
  const selected = generation(1, () => closed.push(rawSettled));
  const manager = yield* makeSessionGenerations(selected).pipe(Effect.provideService(Scope.Scope, root));
  const release = yield* Effect.scoped(Effect.gen(function* () {
    const captured = yield* manager.capture();
    return yield* captured.provide(Effect.map(GenerationRawSlots, (slots) => slots.open()));
  }));
  const closing = yield* Deferred.make<void>();
  yield* Scope.addFinalizer(root, Deferred.succeed(closing, undefined));
  const shutdown = yield* Effect.forkScoped(Scope.close(root, Exit.void));
  yield* Deferred.await(closing);
  expect(closed).toEqual([]);
  rawSettled = true;
  release();
  yield* Fiber.join(shutdown);
  expect(closed).toEqual([true]);
})).pipe(Effect.timeout("5 seconds"))));

test("a retired generation cannot reacquire ownership after its last release notification", () => isolated(Effect.scoped(Effect.gen(function* () {
  const first = generation(1, () => undefined);
  const owner = yield* makeSessionGenerations(first);
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const release = yield* Effect.scoped(Effect.gen(function* () {
    const captured = yield* owner.capture();
    return captured.retain();
  }));
  yield* owner.configure(generation(2, () => undefined), Effect.void);
  const attempted = yield* Effect.sync(() => {
    release();
    return runAgentSync(Effect.result(owner.capture(first).pipe(Effect.provideService(Scope.Scope, scope))));
  });
  expect(attempted).toMatchObject({ _tag: "Failure", failure: { _tag: "GenerationUnavailable", generation: 1 } });
})).pipe(Effect.timeout("5 seconds"))));
