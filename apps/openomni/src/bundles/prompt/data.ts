import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { NamedError } from "@openomni/protocol";
import { z } from "zod";

/** A malformed prompt, role or skill file: the typed boot refusal, never a silent skip. */
export const PromptDataError = NamedError.create(
  "OpenOmniPromptDataError",
  z.object({
    code: z.enum(["invalid_frontmatter", "invalid_sections", "duplicate_name"]),
    path: z.string(),
    message: z.string(),
  }),
);
export type PromptDataError = InstanceType<typeof PromptDataError>;

/** One listed file: what the model sees in a catalog block. */
export interface PromptEntry {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the file the model reads on demand. */
  readonly path: string;
}

export interface PromptCatalog {
  readonly skills: readonly PromptEntry[];
  readonly templates: readonly PromptEntry[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const Text = z.string().trim().min(1);
const SkillFrontmatter = z.object({ name: Text, description: Text });
const TemplateFrontmatter = z.object({ name: Text.optional(), description: Text });

function refuse(code: PromptDataError["data"]["code"], path: string, message: string): PromptDataError {
  return new PromptDataError({ code, path, message: `${path}: ${message}` });
}

function parseYaml(source: string, path: string) {
  try {
    return Bun.YAML.parse(source);
  } catch (cause) {
    throw refuse("invalid_frontmatter", path, `frontmatter is not valid YAML (${String(cause)})`);
  }
}

/** Splits a markdown file into its schema-checked YAML frontmatter and body. */
export function parseMarkdown<Schema extends z.ZodType>(
  text: string,
  path: string,
  schema: Schema,
): { readonly frontmatter: z.output<Schema>; readonly body: string } {
  const match = FRONTMATTER.exec(text);
  if (match === null) throw refuse("invalid_frontmatter", path, "missing YAML frontmatter fenced by ---");
  const parsed = schema.safeParse(parseYaml(match[1] ?? "", path));
  if (!parsed.success) throw refuse("invalid_frontmatter", path, z.prettifyError(parsed.error));
  return { frontmatter: parsed.data, body: match[2] ?? "" };
}

function sortedNames(dir: string): readonly string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function unique(entries: readonly PromptEntry[]): readonly PromptEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw refuse("duplicate_name", entry.path, `name "${entry.name}" is listed twice`);
    seen.add(entry.name);
  }
  return entries;
}

/** Every `<dir>/<skill>/SKILL.md`; a directory without one is not a skill. */
function loadSkills(dir: string): readonly PromptEntry[] {
  const files = sortedNames(dir)
    .map((name) => join(dir, name, "SKILL.md"))
    .filter((file) => existsSync(file));
  return unique(files.map((path) => {
    const { frontmatter } = parseMarkdown(readFileSync(path, "utf-8"), path, SkillFrontmatter);
    return { name: frontmatter.name, description: frontmatter.description, path };
  }));
}

/** Every `<dir>/*.md`; the name defaults to the file stem. */
function loadTemplates(dir: string): readonly PromptEntry[] {
  const files = sortedNames(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile());
  return unique(files.map((path) => {
    const { frontmatter } = parseMarkdown(readFileSync(path, "utf-8"), path, TemplateFrontmatter);
    return { name: frontmatter.name ?? basename(path, ".md"), description: frontmatter.description, path };
  }));
}

/**
 * Reads the Owner's skills and prompt templates at boot. An unset or absent
 * directory lists nothing; any malformed file throws {@link PromptDataError}.
 */
export function loadPromptCatalog(dirs: { readonly skillsDir?: string; readonly promptsDir?: string }): PromptCatalog {
  return {
    skills: dirs.skillsDir === undefined ? [] : loadSkills(resolve(dirs.skillsDir)),
    templates: dirs.promptsDir === undefined ? [] : loadTemplates(resolve(dirs.promptsDir)),
  };
}
