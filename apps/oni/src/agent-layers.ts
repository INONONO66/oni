import { Layer, type Context } from "effect";
import { Core } from "@oni/agent";
const Entropy = Core.Entropy;
type EntropySource = Core.EntropySource;
const ObservationSink = Core.ObservationSink;

/** Composition-root-supplied entropy and a borrowed root observation port; time comes from Effect's Clock. */
export function AgentProcessLive(observations: Context.Service.Shape<typeof ObservationSink>, entropy: EntropySource) {
  return Layer.mergeAll(
    Entropy.layer(entropy),
    Layer.succeed(ObservationSink, observations),
  );
}
