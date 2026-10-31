import { Outbound } from "@oni/protocol";
import { buildAgentPrompt } from "../bundles/prompt/build";
import type { PromptCatalog } from "../bundles/prompt/data";
import { CHILD_PRESET, RESIDENT_PRESET } from "../bundles/prompt/roles";
import { createResident as createResidentBundle, type ResidentOptions as ResidentBundleOptions } from "../bundles/resident/index";
import type { ToolPorts } from "./catalog";

export type ResidentOptions = Omit<ResidentBundleOptions, "presets" | "id" | "clock" | "gateway"> & {
  /** Identity, clock and the gateway door (reply + reactions, #1569); tool bodies bind the same ports through the manifest (#1561). */
  readonly tools: ToolPorts;
  readonly prompts?: PromptCatalog;
};

/** The composing app supplies prompt data; tool faces come from the composed bundles. */
export function createResident(options: ResidentOptions) {
  const { tools: ports, ...resident } = options;
  const computerTools = options.composed?.current().generation.bundles.includes("computer") ?? false;
  return createResidentBundle({
    ...resident,
    presets: {
      resident: buildAgentPrompt(RESIDENT_PRESET, {
        structuredMessages: `Structured messages\n\n${Outbound.prompt()}`,
        catalog: options.prompts,
        computerTools,
      }),
      child: buildAgentPrompt(CHILD_PRESET, { catalog: options.prompts, computerTools }),
    },
    id: ports.id,
    clock: ports.clock,
    gateway: ports.messages,
  });
}
