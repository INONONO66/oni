import type { Model } from "@openomni/protocol";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentPrompt } from "../src/bundles/prompt/build";
import { Outbound } from "@openomni/protocol";
import { loadPromptCatalog, PromptDataError } from "../src/bundles/prompt/data";
import { CHILD_PRESET, parseRolePreset, RESIDENT_PRESET, type RolePreset } from "../src/bundles/prompt/roles";

const residentBase = [
  RESIDENT_PRESET.identity,
  RESIDENT_PRESET.mandate,
  RESIDENT_PRESET.policies,
  RESIDENT_PRESET.style,
]
  .filter((section: string | undefined): section is string => section !== undefined && section !== "")
  .join("\n\n");

describe("buildAgentPrompt", () => {
  test("is deterministic for the same preset and input", () => {
    const input = { model: { provider: "x", id: "model" } };

    expect(buildAgentPrompt(RESIDENT_PRESET, input)).toBe(buildAgentPrompt(RESIDENT_PRESET, input));
  });

  test("includes the resident sections in preset order", () => {
    const sections = [RESIDENT_PRESET.identity, RESIDENT_PRESET.mandate,
      RESIDENT_PRESET.policies, RESIDENT_PRESET.style]
      .filter((section: string | undefined): section is string => Boolean(section));
    expect(buildAgentPrompt(RESIDENT_PRESET)).toBe(sections.join("\n\n"));
  });

  test("omits unavailable optional sections without a trailing separator", () => {
    const base = buildAgentPrompt(RESIDENT_PRESET);

    expect(base).toBe(residentBase);
    expect(base.endsWith("\n")).toBe(false);
    expect(base).not.toContain("\n\n\n");
  });

  test("assembles every populated section in stable-to-volatile order", () => {
    const preset: RolePreset = {
      name: "full",
      identity: "IDENTITY",
      mandate: "MANDATE",
      policies: "POLICIES",
      style: "STYLE",
      tuning: () => "TUNING",
    };

    expect(
      buildAgentPrompt(preset, {
        model: { provider: "x", id: "model" },
      }),
    ).toBe("IDENTITY\n\nMANDATE\n\nPOLICIES\n\nSTYLE\n\nTUNING");
  });

  test("includes model tuning when available and omits it otherwise", () => {
    const preset: RolePreset = {
      name: "tuned",
      identity: "identity",
      mandate: "mandate",
      tuning: (model: Model.Ref) => (model.provider === "x" ? "x tuning" : undefined),
    };
    const xModel: Model.Ref = { provider: "x", id: "model" };
    const yModel: Model.Ref = { provider: "y", id: "model" };

    expect(buildAgentPrompt(preset, { model: xModel })).toBe(
      [preset.identity, preset.mandate, preset.tuning?.(xModel)].join("\n\n"),
    );
    expect(buildAgentPrompt(preset, { model: yModel })).toBe(
      [preset.identity, preset.mandate].join("\n\n"),
    );
  });

  test("resident instructions include structured messages, but child instructions do not", () => {
    const resident = buildAgentPrompt(RESIDENT_PRESET, {
      structuredMessages: `Structured messages\n\n${Outbound.prompt()}`,
    });
    expect(resident).toContain(`Structured messages\n\n${Outbound.prompt()}`);
    expect(buildAgentPrompt(RESIDENT_PRESET)).not.toContain("Structured messages");
    expect(buildAgentPrompt(CHILD_PRESET)).not.toContain("Structured messages");
  });
});

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "openomni-prompt-"));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function refusal(run: () => unknown): PromptDataError["data"] {
  try {
    run();
  } catch (error) {
    if (PromptDataError.isInstance(error)) return error.data;
    throw error;
  }
  throw new Error("expected a prompt data refusal");
}

describe("role files", () => {
  test("the shipped roles parse into their presets", () => {
    expect([RESIDENT_PRESET.name, CHILD_PRESET.name]).toEqual(["resident", "child"]);
    expect(RESIDENT_PRESET.policies).toBeDefined();
    expect(CHILD_PRESET.policies).toBeUndefined();
  });

  test("a role with an unknown section refuses typed", () => {
    const text = "---\nname: x\nrole: child\n---\n## Identity\nI\n## Mandate\nM\n## Mood\nZ\n";
    expect(refusal(() => parseRolePreset(text, "x.md")).code).toBe("invalid_sections");
  });

  test("a role without a mandate refuses typed", () => {
    const text = "---\nname: x\nrole: child\n---\n## Identity\nI\n";
    expect(refusal(() => parseRolePreset(text, "x.md")).code).toBe("invalid_sections");
  });
});

describe("loadPromptCatalog", () => {
  test("lists every skill and template with absolute paths in the system prompt", () => {
    const skills = tree({
      "b-skill/SKILL.md": "---\nname: beta\ndescription: >\n  Second\n  skill\n---\nbody",
      "a-skill/SKILL.md": "---\nname: alpha\ndescription: First skill\nlicense: any\n---\n",
      "notes/README.md": "not a skill",
    });
    const prompts = tree({ "review.md": "---\ndescription: Review a diff\n---\nReview it.", "roles/x.md": "ignored" });
    const catalog = loadPromptCatalog({ skillsDir: skills, promptsDir: prompts });

    expect(catalog).toEqual({
      skills: [
        { name: "alpha", description: "First skill", path: join(skills, "a-skill", "SKILL.md") },
        { name: "beta", description: "Second skill", path: join(skills, "b-skill", "SKILL.md") },
      ],
      templates: [{ name: "review", description: "Review a diff", path: join(prompts, "review.md") }],
    });
    const prompt = buildAgentPrompt({ name: "p", identity: "I", mandate: "M" }, { catalog });
    expect(prompt.split("\n\n").map((block) => block.split("\n")[0])).toEqual([
      "I",
      "M",
      "<skills>",
      "<prompt_templates>",
    ]);
    expect(prompt).toContain(`- alpha: First skill (${join(skills, "a-skill", "SKILL.md")})`);
  });

  test("an unset, absent or empty directory lists nothing", () => {
    const empty = tree({});
    expect(loadPromptCatalog({})).toEqual({ skills: [], templates: [] });
    expect(loadPromptCatalog({ skillsDir: join(empty, "missing"), promptsDir: empty })).toEqual({
      skills: [],
      templates: [],
    });
    expect(buildAgentPrompt(RESIDENT_PRESET, { catalog: loadPromptCatalog({ skillsDir: empty }) })).toBe(residentBase);
  });

  test("a skill missing its description refuses typed", () => {
    const skills = tree({ "x/SKILL.md": "---\nname: x\n---\nbody" });
    expect(refusal(() => loadPromptCatalog({ skillsDir: skills }))).toMatchObject({
      code: "invalid_frontmatter",
      path: join(skills, "x", "SKILL.md"),
    });
  });

  test("bad YAML or missing frontmatter refuses typed", () => {
    const yaml = tree({ "x/SKILL.md": "---\nname: [x\n---\n" });
    const bare = tree({ "plain.md": "no frontmatter" });
    expect(refusal(() => loadPromptCatalog({ skillsDir: yaml })).code).toBe("invalid_frontmatter");
    expect(refusal(() => loadPromptCatalog({ promptsDir: bare })).code).toBe("invalid_frontmatter");
  });

  test("a configured path that is a file refuses typed", () => {
    const file = join(tree({ "SKILL.md": "x" }), "SKILL.md");
    expect(refusal(() => loadPromptCatalog({ skillsDir: file }))).toMatchObject({ code: "not_a_directory", path: file });
  });

  test("two skills with one name refuse typed", () => {
    const skills = tree({
      "a/SKILL.md": "---\nname: same\ndescription: d\n---\n",
      "b/SKILL.md": "---\nname: same\ndescription: d\n---\n",
    });
    expect(refusal(() => loadPromptCatalog({ skillsDir: skills })).code).toBe("duplicate_name");
  });
});
