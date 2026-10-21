import type { Model } from "@oni/protocol";
import type { PromptCatalog, PromptEntry } from "./data";
import type { RolePreset } from "./roles";

function catalogBlock(tag: string, lead: string, entries: readonly PromptEntry[] = []): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map((entry) => `- ${entry.name}: ${entry.description.replace(/\s+/g, " ")} (${entry.path})`);
  return [`<${tag}>`, lead, ...lines, `</${tag}>`].join("\n");
}

export function buildAgentPrompt(
  preset: RolePreset,
  input: { model?: Model.Ref; structuredMessages?: string; catalog?: PromptCatalog } = {},
): string {
  return [
    preset.identity,
    preset.mandate,
    preset.policies,
    preset.style,
    input.structuredMessages,
    catalogBlock(
      "skills",
      "Skills are instruction files. Read a skill's file before acting when its description matches the work.",
      input.catalog?.skills,
    ),
    catalogBlock(
      "prompt_templates",
      "Prompt templates are reusable instructions. Read one when the work calls for it.",
      input.catalog?.templates,
    ),
    input.model === undefined ? undefined : preset.tuning?.(input.model),
  ]
    .filter((section): section is string => section !== undefined && section !== "")
    .join("\n\n");
}
