import { Layer } from "effect";
import type { CompiledPolicySnapshot } from "../../src/core/gate/compile";
import type { AnyToolDefinition, SessionGeneration } from "@oni/protocol";
import { SessionLayer, ToolCatalog } from "../../src/core/ports/ports";

export interface AgentLayerOptions {
  readonly snapshot: SessionGeneration.Snapshot;
  readonly policy: CompiledPolicySnapshot;
  readonly definitions: readonly AnyToolDefinition[];
}

export function AgentGenerationLive(options: AgentLayerOptions) {
  return Layer.mergeAll(
    Layer.succeed(SessionLayer, { snapshot: options.snapshot, policy: options.policy }),
    Layer.succeed(ToolCatalog, { definitions: options.definitions }),
  );
}
