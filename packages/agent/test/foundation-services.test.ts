import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { testBus } from "./helpers/bus";
import { AgentStopError, ContextAdmissionError } from "../src/core/ports/failure";
import { failureEvidence } from "../src/core/loop/executor";
import { AgentGenerationLive } from "./helpers/generation-layer";
import { fixedClockLayer } from "./helpers/time";
import { Clock } from "effect";
import { Entropy, ObservationSink, SessionLayer, ToolCatalog } from "../src/core/ports/ports";
import { allowAllPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";

test("context admission failure remains typed and has closed durable evidence", () => isolated(Effect.gen(function* () {
  const error = new ContextAdmissionError();
  expect((yield* Effect.flip(error))._tag).toBe("ContextAdmissionError");
  expect(failureEvidence(error)).toEqual({ tag: "ContextAdmissionError" });
  const stopped = new AgentStopError({ reason: "budget" });
  expect((yield* Effect.flip(stopped))._tag).toBe("AgentStopError");
  expect(failureEvidence(stopped)).toEqual({ tag: "AgentStopError", code: "agent_stop", reason: "budget" });
})));

test("the generation layer supplies the captured policy, tools, observations, clock and entropy", () => isolated((ledger) => Effect.gen(function* () {
  yield* ledger.kernel.materialize({
    id: "layer-session", role: "resident", parentId: null, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: "configure", at: 1,
  });
  const snapshot = ledger.kernel.latestGenerationFor("layer-session");
  const observations = testBus();
  const options = {
    now: (): number => 123, id: (): string => "fixed-id", observations,
    snapshot, policy: allowAllPolicy, definitions: [],
  };
  const services = yield* Effect.gen(function* () {
    return {
      time: yield* Clock.currentTimeMillis, id: (yield* Entropy).id(),
      observations: yield* ObservationSink, session: yield* SessionLayer, tools: yield* ToolCatalog,
    };
  }).pipe(Effect.provide(Layer.mergeAll(AgentGenerationLive(options),
    fixedClockLayer(options.now), Entropy.layer({ id: options.id, random: () => 0 }),
    Layer.succeed(ObservationSink, observations))));
  expect(services.time).toBe(123);
  expect(services.id).toBe("fixed-id");
  expect(services.observations).toBe(observations);
  expect(services.session.snapshot).toBe(snapshot);
  expect(services.session.policy).toBe(allowAllPolicy);
  expect(services.tools.definitions).toBe(options.definitions);
})));
