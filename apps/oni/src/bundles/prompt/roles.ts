import type { Model } from "@oni/protocol";
import { z } from "zod";
import { PromptDataError, parseMarkdown } from "./data";
import { roleText } from "./embed" with { type: "macro" };

export interface RolePreset {
  readonly name: string;
  readonly identity: string;
  readonly mandate: string;
  readonly policies?: string;
  readonly style?: string;
  readonly tuning?: (model: Model.Ref) => string | undefined;
}

const RoleFrontmatter = z.object({ name: z.string().trim().min(1), role: z.enum(["resident", "child"]) });
const SECTIONS = ["identity", "mandate", "policies", "style"] as const;
type Section = (typeof SECTIONS)[number];

function isSection(heading: string): heading is Section {
  return SECTIONS.some((section) => section === heading);
}

function readSections(body: string, path: string): ReadonlyMap<Section, string> {
  const [preamble = "", ...parts] = body.split(/^## +(.+?) *$/m);
  if (preamble.trim() !== "") {
    throw new PromptDataError({ code: "invalid_sections", path, message: `${path}: text before the first ## section` });
  }
  const sections = new Map<Section, string>();
  for (let index = 0; index < parts.length; index += 2) {
    const heading = (parts[index] ?? "").toLowerCase();
    if (!isSection(heading) || sections.has(heading)) {
      throw new PromptDataError({
        code: "invalid_sections",
        path,
        message: `${path}: section "${heading}" is unknown or repeated; expected ${SECTIONS.join(", ")}`,
      });
    }
    sections.set(heading, (parts[index + 1] ?? "").trim());
  }
  return sections;
}

/** Parses one role file: `name`/`role` frontmatter, then ## Identity, Mandate, Policies, Style. */
export function parseRolePreset(text: string, path: string): RolePreset {
  const { frontmatter, body } = parseMarkdown(text, path, RoleFrontmatter);
  const sections = readSections(body, path);
  const identity = sections.get("identity");
  const mandate = sections.get("mandate");
  if (!identity || !mandate) {
    throw new PromptDataError({ code: "invalid_sections", path, message: `${path}: Identity and Mandate are required` });
  }
  const policies = sections.get("policies");
  const style = sections.get("style");
  return {
    name: frontmatter.name,
    identity,
    mandate,
    ...(policies ? { policies } : {}),
    ...(style ? { style } : {}),
  };
}

export const RESIDENT_PRESET: RolePreset = parseRolePreset(roleText("resident"), "prompts/roles/resident.md");
export const CHILD_PRESET: RolePreset = parseRolePreset(roleText("child"), "prompts/roles/child.md");
