import { Outbound, type LedgerSession } from "@openomni/protocol";
import { buildAgentPrompt } from "../bundles/prompt/build";
import { CHILD_PRESET, RESIDENT_PRESET } from "../bundles/prompt/roles";
import { createResident as createResidentBundle, type ResidentOptions as ResidentBundleOptions } from "../bundles/resident/index";
import { catalogDefinitions, type ToolPorts } from "./catalog";
import { toolCatalogLayer } from "./generation-layers";

export type ResidentOptions = Omit<ResidentBundleOptions, "tools" | "presets" | "id" | "clock" | "reactions"> & {
  readonly tools: ToolPorts;
};

/** The composing app supplies prompt data and freshly acquired catalog definitions. */
export function createResident(options: ResidentOptions) {
  const { tools: ports, ...resident } = options;
  const catalog = catalogDefinitions(ports);
  const definitionsFor = (role: LedgerSession.Role) =>
    catalog.filter((tool) => tool.visibility.model.includes(role) || tool.visibility.cell.includes(role));
  return createResidentBundle({
    ...resident,
    tools: {
      resident: definitionsFor("resident"),
      child: definitionsFor("child"),
      catalogLayer: (select) => toolCatalogLayer(ports, select),
    },
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
