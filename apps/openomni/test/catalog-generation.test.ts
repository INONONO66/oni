import { composedHolder } from "./helpers/bundle-fixture";
import { APPROVAL_POLICY } from "../src/bundles/approval-policy/index";
import { expect, test } from "bun:test";
import { Core, Testing } from "@openomni/agent";
const GenerationLayers = Core.GenerationLayers;
const ToolCatalog = Core.ToolCatalog;
type ToolCatalog = Core.ToolCatalog;
const session = Testing.session;
const projectTools = Core.projectTools;
import type { AnyToolDefinition } from "@openomni/protocol";
import { Effect, type Layer } from "effect";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../src/gateway";
import { seedKernelPolicyRows } from "../src/composition/policy";
import { createResident } from "../src/composition/resident";
import type { CatalogSelection, GenerationDefinitions } from "../src/composition/generation-layers";
import { testToolPorts } from "./helpers/tool-ports";
import { allowConfigure } from "./helpers/generation-services";
import { planeOf } from "./helpers/ledger";
import { Bus } from "./helpers/bus";

test("two turns retain one catalog Layer; configure acquires a fresh generation catalog", async () => {
  const layers: Layer.Layer<ToolCatalog>[] = [];
  const turns: (readonly AnyToolDefinition[])[] = [];
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  const plane = await planeOf(runtime);
  const resident = createResident({
    model: { provider: "test", id: "test" }, apiKey: "test", tools: testToolPorts,
    sessionRuntime: {
      approvalPolicy: APPROVAL_POLICY,
      authorizeConfigure: allowConfigure,
      openKernel: plane.openKernel,
      listSessions: plane.listSessions,
    },
    policyGeneration: () => plane.openKernel("catalog-once").currentPolicyGeneration(),
  });
  const schema = resident.definitions.resident;
  const definitions: GenerationDefinitions = {
    ...resident.definitions,
    catalogLayer: (select: CatalogSelection) => {
      const recipe = resident.definitions.catalogLayer;
      if (recipe === undefined) throw new Error("resident catalog Layer recipe missing");
      const layer = recipe(select);
      layers.push(layer);
      return layer;
    },
  };
  try {
    const handle = await acquireAppResource(runtime, Effect.gen(function* () {
      seedKernelPolicyRows(plane.catalog.policies);
      yield* (yield* GenerationLayers).initialize(definitions);
      return yield* session({
        id: "catalog-once", role: "resident", tools: projectTools(schema).session,
        runner: () => Effect.gen(function* () {
          turns.push((yield* ToolCatalog).definitions);
          return { kind: "result" as const, text: "done" };
        }),
      }, {
        approvalPolicy: APPROVAL_POLICY,
        authorizeConfigure: allowConfigure,
        openKernel: plane.openKernel,
        listSessions: plane.listSessions,
      });
    }));
    await runAppEffect(runtime, handle.prompt("first"));
    await runAppEffect(runtime, handle.prompt("second"));
    expect(layers).toHaveLength(1);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe(turns[0]);
    expect(turns[0]?.map((tool: AnyToolDefinition) => tool.name)).toEqual(schema.map((tool: AnyToolDefinition) => tool.name));
    await runAppEffect(runtime, handle.system.blocks.set([{ id: "changed", source: "test", content: "generation-two" }]));
    await runAppEffect(runtime, handle.prompt("third"));
    expect(layers).toHaveLength(2);
    expect(layers[1]).not.toBe(layers[0]);
    expect(turns[2]).not.toBe(turns[0]);
    expect(turns[2]?.[0]).not.toBe(turns[0]?.[0]);
  } finally {
    await runtime.dispose();
  }
});
