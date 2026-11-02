import { expect, test } from "bun:test";
import type { Delivery } from "@oni/protocol";
import { createAutomationDelivery } from "../src/composition/automation-delivery";
import { createResident } from "../src/composition/resident";
import { ComposedGeneration } from "../src/composition/composed";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { buildAgentPrompt } from "../src/bundles/prompt/build";
import { runAppEffect } from "../src/gateway";
import { automationFixture } from "./helpers/automation";
import { residentSuite } from "./helpers/resident-suite";
import { allowConfigure } from "./helpers/generation-services";
import { testToolPorts } from "./helpers/tool-ports";

const suite = residentSuite();

test.each(["action", "prompt"] as const)("automation %s selects a persona without turning instructions into system text", async (kind) => {
  const f = await automationFixture(suite);
  const agent = f.plane.stores.agents.add({
    id: "x", prompt: { identity: "IDENTITY_SENTINEL", mandate: "MANDATE_SENTINEL" }, tools: ["eval"],
  });
  const composed = await runAppEffect(f.app.runtime, ComposedGeneration);
  const resident = createResident({
    agents: f.plane.stores.agents, composed, model: { provider: "fake", id: "primary" }, apiKey: "test",
    tools: testToolPorts,
    sessionRuntime: { approvalPolicy: APPROVAL_POLICY, authorizeConfigure: allowConfigure },
    policyGeneration: () => f.plane.openKernel("gateway-ingress").currentPolicyGeneration(),
  });
  const commit = createAutomationDelivery(
    { plane: f.plane, client: await f.client(), clock: () => f.time.now }, f.stores.automations, resident.genesis,
  );
  const input: Delivery.Commit = {
    id: "automation-input", sessionId: "automated", kind,
    content: [{ kind: "text", text: "INPUT_SENTINEL" }],
    origin: { encodingVersion: 1, value: {
      kind: "external", inboundTreatment: "full_access",
      automation: { id: "fixture", newSession: true, agent: "x", instructions: "INSTRUCTIONS_SENTINEL" },
    } },
    createdAt: f.time.now, parentActionId: null,
    createSession: resident.genesis("automated", null, "resident", "resident"),
  };
  await runAppEffect(f.app.runtime, commit(input));
  const reads = f.plane.read.session("automated");
  expect(reads.row("automated")).toMatchObject({ agent: "x", role: "resident" });
  const snapshot = reads.latestGenerationFor("automated");
  expect(snapshot.systemPreset).toBe(buildAgentPrompt({ name: agent.id, ...agent.prompt }));
  expect(snapshot.tools.map((tool) => tool.name)).toEqual(["eval"]);
  const prompt = reads.actionById(kind === "action" ? "automation-input:instructions" : "automation-input");
  expect(prompt?.effect.value).toMatchObject({ content: [{
    kind: "text", text: kind === "action" ? "INSTRUCTIONS_SENTINEL" : "INSTRUCTIONS_SENTINEL\n\nINPUT_SENTINEL",
  }] });

  await runAppEffect(f.app.runtime, commit({
    ...input, id: "existing-input",
    origin: { encodingVersion: 1, value: { automation: { id: "fixture", newSession: false, agent: "child" } } },
  }));
  expect(reads.row("automated").agent).toBe("x");
});
