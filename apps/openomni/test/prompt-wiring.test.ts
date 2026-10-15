import { expect, test } from "bun:test";
import { SessionGeneration, type LedgerSession } from "@openomni/protocol";
import type { PromptCatalog } from "../src/bundles/prompt/data";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { createResident } from "../src/composition/resident";
import { allowConfigure } from "./helpers/generation-services";
import { testPlane } from "./helpers/ledger";
import { testToolPorts } from "./helpers/tool-ports";

function systemPrompt(
  resident: ReturnType<typeof createResident>,
  role: Extract<LedgerSession.Role, "resident" | "child">,
): string {
  const materialization = resident.genesis(`prompt-wiring-${role}`, null, role, role);
  return SessionGeneration.ConfigureEffect.parse(materialization.initialAction.effect.value).snapshot.systemPreset;
}

test("a configured skill is present in resident and child system prompts", () => {
  const plane = testPlane();
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
  try {
    const resident = createResident({
      model: { provider: "fixture", id: "fixture" },
      apiKey: "fixture",
      prompts,
      tools: testToolPorts,
      sessionRuntime: {
        approvalPolicy: APPROVAL_POLICY,
        authorizeConfigure: allowConfigure,
        openKernel: plane.openKernel,
        listSessions: plane.listSessions,
      },
      policyGeneration: () => 1,
    });

    expect(systemPrompt(resident, "resident")).toContain("fixture-skill");
    expect(systemPrompt(resident, "child")).toContain("fixture-skill");
  } finally {
    plane.close();
  }
});
