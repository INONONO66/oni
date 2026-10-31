import { expect, test } from "bun:test";
import { SessionGeneration, type LedgerSession } from "@oni/protocol";
import type { PromptCatalog } from "../src/bundles/prompt/data";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { createResident } from "../src/composition/resident";
import { alarmPortsSlot, composedHolderOf } from "../src/composition/composed";
import { allowConfigure } from "./helpers/generation-services";
import { testToolPorts, toolComposition } from "./helpers/tool-ports";

function systemPrompt(
  resident: ReturnType<typeof createResident>,
  role: Extract<LedgerSession.Role, "resident" | "child">,
): string {
  const materialization = resident.genesis(`prompt-wiring-${role}`, null, role, role);
  return SessionGeneration.ConfigureEffect.parse(materialization.initialAction.effect.value).snapshot.systemPreset;
}

test("a configured skill is present in resident and child system prompts", () => {
  const prompts: PromptCatalog = {
    skills: [
      {
        name: "fixture-skill",
        description: "Exercises prompt catalog wiring",
        path: "/fixtures/fixture-skill/SKILL.md",
      },
    ],
    templates: [],
  };
  const resident = createResident({
    model: { provider: "fixture", id: "fixture" },
    apiKey: "fixture",
    prompts,
    tools: testToolPorts,
    sessionRuntime: {
      approvalPolicy: APPROVAL_POLICY,
      authorizeConfigure: allowConfigure,
    },
    policyGeneration: () => 1,
  });

  expect(systemPrompt(resident, "resident")).toContain("fixture-skill");
  expect(systemPrompt(resident, "child")).toContain("fixture-skill");
});

test("computer guidance follows the composed tool pack for both roles", () => {
  const base = toolComposition(testToolPorts);
  const options = {
    model: { provider: "fixture", id: "fixture" },
    apiKey: "fixture",
    tools: testToolPorts,
    sessionRuntime: { approvalPolicy: APPROVAL_POLICY, authorizeConfigure: allowConfigure },
    policyGeneration: () => 1,
  };
  const without = createResident({ ...options, composed: composedHolderOf(base, alarmPortsSlot()) });
  const withPack = createResident({
    ...options,
    composed: composedHolderOf({
      ...base,
      generation: { ...base.generation, bundles: [...base.generation.bundles, "computer"] },
    }, alarmPortsSlot()),
  });

  for (const role of ["resident", "child"] as const) {
    const plain = systemPrompt(without, role).split("\n\n");
    const offered = systemPrompt(withPack, role).split("\n\n");
    expect(offered.length).toBe(plain.length + 1);
    expect(offered.filter((section) => plain.includes(section))).toEqual(plain);
  }
});
