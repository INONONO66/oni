import { Core } from "@oni/agent";
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
type SessionRuntime = Core.SessionRuntime;
import { AgentProcessLive } from "../../src/agent-layers";
import { Bus } from "./bus";
const Llm = Core.Llm;
import { LlmLive } from "../../src/runtime";
import { Effect, Layer, Scope, type Context } from "effect";
import { AppLedger } from "../../src/composition/cluster-runtime";
import type { TestLedgerPlane as AppLedgerPlane } from "./ledger";
import { createAppLedger } from "./ledger";
import { ComposedGeneration, composedHolderOf, alarmPortsSlot, type ComposedContext } from "../../src/composition/composed";
import { Bundle } from "@oni/agent";
import { GenerationLayersLive } from "../../src/composition/generation-layers";
import { AppPointTable, composedPointTable } from "../../src/composition/point-table";
import { wallClockLayer } from "../../src/composition/platform";
import { testClock, testEntropy } from "./test-entropy";
import type { ToolPorts } from "../../src/composition/catalog";
import { toolComposition } from "./tool-ports";

const EMPTY_MANIFEST = Bundle.Manifest.define({ capabilities: [], bundles: [], off: [] });
const composedEmpty: ComposedContext = { manifest: EMPTY_MANIFEST, generation: Bundle.composeSync(EMPTY_MANIFEST) };

/** Tests grant configure EXPLICITLY; the app composition wires the real pinned pre-policy. */
export const allowConfigure: SessionRuntime["authorizeConfigure"] = () => Effect.succeed(true);

/** A borrowed-storage composition for package-boundary app fixtures. */
export function generationServices(options: {
  /** Compose the product tool bundles over these ports (#1561); ignored when `composed` is given. */
  readonly tools?: ToolPorts;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: Context.Service.Shape<typeof ObservationSink>;
  readonly llm?: Context.Service.Shape<typeof Llm>;
  /** The app ledger plane the generation manager reads; absent builds a scoped in-memory one. */
  readonly plane?: AppLedgerPlane;
  /** The composed generation the layers read; absent composes empty. */
  readonly composed?: { readonly current: () => ComposedContext };
} = {}) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const now = options.clock ?? testClock();
    const plane = options.plane === undefined
      ? yield* Effect.acquireRelease(
          Effect.sync(() => createAppLedger({ now, observationSink: options.observations ?? Bus })),
          (owned) => Effect.sync(() => owned.close()),
        ).pipe(Scope.provide(scope))
      : options.plane;
    const process = Layer.mergeAll(
      AgentProcessLive(options.observations ?? Bus, testEntropy(options.entropy)),
      Layer.succeed(ComposedGeneration, composedHolderOf(
        options.composed?.current() ?? (options.tools === undefined ? composedEmpty : toolComposition(options.tools)),
        alarmPortsSlot(),
      )),
      Layer.succeed(AppLedger, plane),
      Layer.succeed(AppPointTable, composedPointTable()),
      wallClockLayer(now),
    );
    const layer = GenerationLayersLive.pipe(Layer.provideMerge(process), Layer.merge(options.llm === undefined ? LlmLive : Layer.succeed(Llm, options.llm)));
    const context = yield* Layer.buildWithScope(layer, scope);
    yield* Effect.flatMap(GenerationLayers, (generations) => generations.initialize({ resident: [], child: [] })).pipe(Effect.provide(context));
    return context;
  });
}
