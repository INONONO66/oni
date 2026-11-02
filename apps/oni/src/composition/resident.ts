import { Outbound, type AnyToolDefinition } from "@oni/protocol";
import { buildAgentPrompt } from "../bundles/prompt/build";
import type { PromptCatalog } from "../bundles/prompt/data";
import type { AgentStore } from "../agents";
import { CHILD_PRESET, RESIDENT_PRESET } from "../bundles/prompt/roles";
import { createResident as createResidentBundle, type ResidentOptions as ResidentBundleOptions } from "../bundles/resident/index";
import type { ToolPorts } from "./catalog";

export type ResidentOptions = Omit<ResidentBundleOptions, "prompt" | "id" | "clock" | "gateway"> & {
  /** Identity, clock and the gateway door (reply + reactions, #1569); tool bodies bind the same ports through the manifest (#1561). */
  readonly tools: ToolPorts;
  readonly prompts?: PromptCatalog;
  readonly agents: AgentStore;
};

/** Code-owned seeds track the shipped prompt and manifest on every boot. */
export function seedAgents(store: AgentStore, tools: readonly Pick<AnyToolDefinition, "name" | "visibility">[]): void {
  for (const [id, preset] of [["resident", RESIDENT_PRESET], ["child", CHILD_PRESET]] as const) {
    const { identity, mandate, policies, style } = preset;
    store.seed({
      id,
      enabled: true,
      prompt: { identity, mandate, ...(policies === undefined ? {} : { policies }), ...(style === undefined ? {} : { style }) },
      tools: [...new Set(tools.filter((tool) =>
        tool.visibility.model.includes(id) || tool.visibility.cell.includes(id),
      ).map((tool) => tool.name))],
    });
  }
}

/** The composing app supplies prompt data; tool faces come from the composed bundles. */
export function createResident(options: ResidentOptions) {
  const { tools: ports, ...resident } = options;
  const composed = options.composed?.current();
  seedAgents(options.agents, composed?.manifest.bundles.flatMap((bundle) => bundle.tools ?? []) ?? []);
  const computerPack = composed?.manifest.bundles.find((bundle) => bundle.name === "computer");
  const computerTools = computerPack !== undefined &&
    composed?.generation.bundles.includes(computerPack.name) &&
    computerPack.tools.some((tool) => composed.generation.tools.some((offered) => offered.name === tool.name));
  return createResidentBundle({
    ...resident,
    prompt: (agent) => buildAgentPrompt({ name: agent.id, ...agent.prompt }, {
      ...(agent.id === "resident" ? { structuredMessages: `Structured messages\n\n${Outbound.prompt()}` } : {}),
      catalog: options.prompts,
      computerTools: computerTools && computerPack.tools.some((tool) => agent.tools.includes(tool.name)),
    }),
    id: ports.id,
    clock: ports.clock,
    gateway: ports.messages,
  });
}
