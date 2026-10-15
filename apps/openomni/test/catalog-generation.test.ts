import { composedHolder } from "./helpers/bundle-fixture";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { expect, test } from "bun:test";
import { Core, Testing } from "@openomni/agent";
const GenerationLayers = Core.GenerationLayers;
const ToolCatalog = Core.ToolCatalog;
const session = Testing.session;
const projectTools = Core.projectTools;
import type { AnyToolDefinition } from "@openomni/protocol";
import { Effect } from "effect";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../src/gateway";
import { seedKernelPolicyRows } from "../src/composition/policy";
import { approvalPolicyBundle } from "../src/bundles/approval-policy/index";
import { bundleTools, testToolPorts, toolBundles } from "./helpers/tool-ports";
import { allowConfigure } from "./helpers/generation-services";
import { planeOf } from "./helpers/ledger";
import { Bus } from "./helpers/bus";

test("two turns retain one bundle-owned catalog; configure acquires a fresh generation catalog", async () => {
  const turns: (readonly AnyToolDefinition[])[] = [];
  const runtime = gatewayRuntime({
    composed: composedHolder({ bundles: [...toolBundles(testToolPorts), approvalPolicyBundle()] }),
    observations: Bus,
  });
  const plane = await planeOf(runtime);
  const schema = bundleTools(testToolPorts).filter(
    (tool) => tool.visibility.model.includes("resident") || tool.visibility.cell.includes("resident"),
  );
  try {
    const handle = await acquireAppResource(runtime, Effect.gen(function* () {
      seedKernelPolicyRows(plane.catalog.policies);
      yield* (yield* GenerationLayers).initialize({ resident: [], child: [] });
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
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe(turns[0]);
    expect(turns[0]?.map((tool: AnyToolDefinition) => tool.name)).toEqual(schema.map((tool: AnyToolDefinition) => tool.name));
    await runAppEffect(runtime, handle.system.blocks.set([{ id: "changed", source: "test", content: "generation-two" }]));
    await runAppEffect(runtime, handle.prompt("third"));
    expect(turns[2]).not.toBe(turns[0]);
    // #1561: the bundle owns its definitions, so the fresh catalog reuses them.
    expect(turns[2]?.map((tool: AnyToolDefinition) => tool.name)).toEqual(turns[0]?.map((tool: AnyToolDefinition) => tool.name));
  } finally {
    await runtime.dispose();
  }
});
