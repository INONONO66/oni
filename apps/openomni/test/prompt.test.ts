import type { Model } from "@openomni/protocol";
import { describe, expect, test } from "bun:test";
import { buildAgentPrompt } from "../src/bundles/prompt/build";
import { CHILD_PRESET, RESIDENT_PRESET, type RolePreset } from "../src/bundles/prompt/roles";
import { Outbound } from "@openomni/protocol";

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
