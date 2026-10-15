import { Outbound } from "@openomni/protocol";
import { buildAgentPrompt } from "../bundles/prompt/build";
import { CHILD_PRESET, RESIDENT_PRESET } from "../bundles/prompt/roles";
import { createResident as createResidentBundle, type ResidentOptions as ResidentBundleOptions } from "../bundles/resident/index";
import type { ToolPorts } from "./catalog";

export type ResidentOptions = Omit<ResidentBundleOptions, "presets" | "id" | "clock" | "reactions"> & {
  /** Identity, clock and reaction door; tool bodies bind the same ports through the manifest (#1561). */
  readonly tools: ToolPorts;
};

/** The composing app supplies prompt data; tool faces come from the composed bundles. */
export function createResident(options: ResidentOptions) {
  const { tools: ports, ...resident } = options;
  return createResidentBundle({
    ...resident,
    presets: {
      resident: buildAgentPrompt(RESIDENT_PRESET, {
        structuredMessages: `Structured messages\n\n${Outbound.prompt()}`,
      }),
      child: buildAgentPrompt(CHILD_PRESET),
    },
    id: ports.id,
    clock: ports.clock,
    reactions: ports.messages,
  });
}
