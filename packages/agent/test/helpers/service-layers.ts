import * as SessionHandleStore from "../../src/core/store/fence";
import type { AnyToolDefinition, Tool } from "@openomni/protocol";
import { Clock, Context, Effect, Layer } from "effect";
import type { ResolvedExecutorOptions } from "../../src/core/loop/executor";
import { Entropy, ObservationSink, SessionLayer, ToolCatalog } from "../../src/core/ports/ports";
import { scopeObservation } from "../../src/core/observation/bus";
import { testBusService } from "./isolated";
import { entropySource, fixedClock } from "./time";
import { createTurnDispatcher } from "../../src/plugins/tool";

/** The dispatcher-backed tool surface of a chat fixture config. */
export function dispatcherToolPorts(
  dispatcher: Effect.Success<ReturnType<typeof createTurnDispatcher>>,
  input: { readonly sessionId: string; readonly turnId: string },
) {
  return {
    tools: [...dispatcher.specs],
    toolWave: (calls: readonly Tool.Call[], signal?: AbortSignal) =>
      dispatcher.executeWave(calls, { sessionId: input.sessionId, turnId: input.turnId, signal }),
    toolExecutor: (call: Tool.Call) =>
      dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId }),
  };
}

/** Turn dispatcher over the test layers: given catalog plus the fixture's clock/entropy/sink. */
export function testTurnDispatcher(
  input: Parameters<typeof turnTestLayer>[0],
  fixture: Parameters<typeof turnTestLayer>[1],
  definitions: readonly AnyToolDefinition[] = [],
) {
  return createTurnDispatcher(input, fixture).pipe(
    Effect.provide(catalogLayer(definitions)),
    Effect.provide(turnTestLayer(input, fixture)),
  );
}

export function turnTestLayer(input: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] },
  fixture: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">>) {
  return Layer.effectContext(Effect.gen(function* () {
    const current = yield* SessionLayer;
    const clock = yield* Clock.clockWith(Effect.succeed);
    const entropy = yield* Entropy;
    const observations = yield* ObservationSink;
    return Context.make(SessionLayer, { ...current, policy: input.policy ?? current.policy }).pipe(
      Context.add(Clock.Clock, fixture.clock === undefined ? clock : fixedClock(fixture.clock)),
      Context.add(Entropy, fixture.entropy === undefined ? entropy : { id: fixture.entropy, random: entropy.random }),
      Context.add(ObservationSink, fixture.observations === undefined ? observations : observationService(fixture.observations)),
    );
  }));
}

export function observationService(sink: ResolvedExecutorOptions["observations"]) {
  let time = 0;
  const source = { id: entropySource("event").id, now: () => (time += 1) };
  const bus = testBusService(source);
  const service = {
    publish: ((event, data) => { sink.publish(event, data); bus.publish(event, data); }) satisfies typeof bus.publish,
    subscribe: "subscribe" in sink && sink.subscribe !== undefined ? sink.subscribe.bind(sink) : bus.subscribe,
    scope: (identity: Parameters<typeof scopeObservation>[1]): import("@openomni/protocol").ObservationSink => scopeObservation(service, identity, source),
  };
  return service;
}

/** Fixture values become actual providers, not executor option overrides. */
export function executorLayer(values: Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations" | "policy">) {
  const snapshot = SessionHandleStore.generationSnapshot({ generation: 1, revertTo: 0, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: values.policy.generation });
  return Layer.mergeAll(
    Layer.succeed(Clock.Clock, fixedClock(values.clock)),
    Layer.succeed(Entropy, { id: values.entropy, random: () => 0 }),
    Layer.succeed(ObservationSink, observationService(values.observations)),
    Layer.succeed(SessionLayer, { snapshot, policy: values.policy }),
  );
}

export function catalogLayer(definitions: readonly AnyToolDefinition[]) {
  return Layer.succeed(ToolCatalog, { definitions });
}
