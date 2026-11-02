import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { Ingress, type Delivery } from "@oni/protocol";
import { Cause, Effect, Exit } from "effect";
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

async function deliveryFixture(defect?: Error) {
  const f = await automationFixture(suite);
  const composed = await runAppEffect(f.app.runtime, ComposedGeneration);
  const resident = createResident({
    agents: f.plane.stores.agents, composed, model: { provider: "fake", id: "primary" }, apiKey: "test",
    tools: testToolPorts,
    sessionRuntime: { approvalPolicy: APPROVAL_POLICY, authorizeConfigure: allowConfigure },
    policyGeneration: () => f.plane.openKernel("gateway-ingress").currentPolicyGeneration(),
  });
  const commit = createAutomationDelivery(
    { plane: f.plane, client: await f.client(), clock: () => f.time.now }, f.stores.rules,
    defect === undefined ? resident.genesis : () => { throw defect; },
  );
  return { f, resident, commit };
}

test.each(["action", "prompt"] as const)("automation %s selects a persona without turning instructions into system text", async (kind) => {
  const { f, resident, commit } = await deliveryFixture();
  const agent = f.plane.stores.agents.add({
    id: "x", prompt: { identity: "IDENTITY_SENTINEL", mandate: "MANDATE_SENTINEL" }, tools: ["eval"],
  });
  const input: Delivery.Commit = {
    id: "automation-input", sessionId: "automated", kind,
    content: [{ kind: "text", text: "INPUT_SENTINEL" }],
    origin: { encodingVersion: 1, value: {
      kind: "external", inboundTreatment: "full_access",
      rule: { id: "fixture", newSession: true, agent: "x", instructions: "INSTRUCTIONS_SENTINEL" },
    } },
    createdAt: f.time.now, parentActionId: null,
    createSession: resident.genesis("automated", null, "resident", "resident"),
  };
  await runAppEffect(f.app.runtime, commit(input));
  const reads = f.plane.read.session("automated");
  expect(reads.row("automated")).toMatchObject({ agent: "x", role: "resident" });
  const snapshot = reads.latestGenerationFor("automated");
  expect(snapshot.systemPreset).toBe(buildAgentPrompt({ name: agent.id, ...agent.prompt }));
  const loadout = await runAppEffect(f.app.runtime, Effect.scoped(Effect.gen(function* () {
    const generations = yield* Core.GenerationLayers;
    const captured = yield* generations.capture({ sessionId: "automated", generation: snapshot.generation });
    const catalog = yield* captured.provide(Core.ToolCatalog);
    return catalog.definitions.map((tool) => tool.name);
  })));
  expect(loadout).toEqual(["eval"]);
  const prompt = reads.actionById(kind === "action" ? "automation-input:instructions" : "automation-input");
  expect(prompt?.effect.value).toMatchObject({ content: [{
    kind: "text", text: kind === "action" ? "INSTRUCTIONS_SENTINEL" : "INSTRUCTIONS_SENTINEL\n\nINPUT_SENTINEL",
  }] });

  await runAppEffect(f.app.runtime, commit({
    ...input, id: "existing-input",
    origin: { encodingVersion: 1, value: { rule: { id: "fixture", newSession: false, agent: "child" } } },
  }));
  expect(reads.row("automated").agent).toBe("x");
});

test.each(["missing", "disabled", "defect"])("automation handles a %s agent selection without creating a session", async (state) => {
  const defect = new Error("GENESIS_DEFECT");
  const { f, commit } = await deliveryFixture(state === "defect" ? defect : undefined);
  if (state === "disabled") {
    f.plane.stores.agents.add({ id: "x", prompt: { identity: "IDENTITY", mandate: "MANDATE" }, tools: [] });
    f.plane.stores.agents.disable("x");
  }
  f.stores.rules.record(Ingress.Events.RoutingDecision.schema.parse({
    traceId: "trace", time: f.time.now, inboundId: "refused-input", surface: "discord",
    mode: "direct", stage: "automation", outcome: "record", decision: "matched",
    by: "rule/fixture", reason: "matched", factsUsed: ["event"], factsDigest: "digest",
  }));
  const delivery = commit({
    id: "refused-input", sessionId: "refused-session", kind: "prompt",
    content: [{ kind: "text", text: "INPUT_SENTINEL" }],
    origin: { encodingVersion: 1, value: { rule: { id: "fixture", newSession: true, agent: "x" } } },
    createdAt: f.time.now, parentActionId: null,
  });
  if (state === "defect") {
    const exit = await runAppEffect(f.app.runtime, Effect.exit(delivery));
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(defect);
  } else {
    const failure = await runAppEffect(f.app.runtime, Effect.flip(delivery));
    const reason = `agent_${state === "missing" ? "not_found" : "disabled"}`;
    expect(failure).toMatchObject({ _tag: "AgentFailure", operation: "automation.deliver", cause: reason });
    expect(f.stores.rules.decisions("refused-input")).toContainEqual(expect.objectContaining({ decision: "refused", reason }));
  }
  expect(f.plane.read.sessions.list().some((row) => row.id === "refused-session")).toBe(false);
});
