import type { Model } from "@openomni/protocol";
import type { RolePreset } from "./roles";

export function buildAgentPrompt(preset: RolePreset, input: { model?: Model.Ref } = {}): string {
  return [
    preset.identity,
    preset.mandate,
    preset.policies,
    preset.style,
    input.model === undefined ? undefined : preset.tuning?.(input.model),
  ]
    .filter((section): section is string => section !== undefined && section !== "")
    .join("\n\n");
}
