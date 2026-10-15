import type { Model } from "@openomni/protocol";
import type { Effect } from "effect";
import { classifyFailure } from "./classify";
import type { LlmError } from "./errors";
import { resolveAuthFilePath, resolveProviderRows } from "./model/loader";
import type { FailureClass, FailureFacts } from "./port";
import { Provider } from "./provider";
import { mergeRows, type ProviderRow } from "./provider/rows";
import { run, type Run, type RunInput } from "./run";
import type { Sink } from "./sink";

/**
 * The call layer's service, shaped as the agent core's `LlmPort` (#1352):
 * the core declares the port and its `Llm` tag, this package never imports
 * the core, and the composition root binds this service to that tag.
 *
 * One attempt per `run`; retry admission belongs to the core loop. The
 * contract takes no `authFilePath`: the credential file location is resolved
 * once by the composition root and closed over by the implementation
 * (#1245), so consumers cannot redirect credential I/O.
 */
export interface LlmService {
  readonly resolveModel: (ref: Model.Ref, now: () => number) => Effect.Effect<Provider.Model, LlmError>;
  /** The optional third argument is the stream-constructor seam tests inject; the core port never passes it. */
  readonly run: (input: RunInput, sink: Sink, dependencies?: Parameters<typeof run>[2]) => Effect.Effect<Run.Outcome, LlmError>;
  readonly classifyFailure: (facts: FailureFacts) => FailureClass;
}

/**
 * The port-shaped service over the real SDK. The credential file location is
 * resolved once, when the service is built, and closed over here (#1245): a
 * later environment change cannot redirect the credential reads and writes
 * of a running service.
 */
export function makeLlmService(
  authFilePath = resolveAuthFilePath(),
  providers: readonly ProviderRow[] = resolveProviderRows(),
): LlmService {
  const rows = mergeRows(providers);
  return {
    resolveModel: (ref, now) => Provider.resolveModel({ provider: ref.provider, id: ref.id, now, authFilePath, rows }),
    run: (input, sink, dependencies) => run({ ...input, authFilePath }, sink, dependencies),
    classifyFailure,
  };
}
