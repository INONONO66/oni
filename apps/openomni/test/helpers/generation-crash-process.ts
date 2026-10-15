import { APPROVAL_POLICY } from "../../src/composition/policy";
import { Core, Testing } from "@openomni/agent";
const GenerationLayers = Core.GenerationLayers;
const session = Testing.session;
import { Deferred, Effect } from "effect";
import { z } from "zod";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../../src/gateway";
import { AppLedger } from "../../src/composition/cluster-runtime";
import { AppScope } from "../../src/runtime";
import { seedKernelPolicyRows } from "../../src/composition/policy";
import { auditBundle, composedHolder } from "./bundle-fixture";
import { allowConfigure } from "./generation-services";
import { Bus } from "./bus";

const [catalogPath, sessionsDir, auditPath] = z
  .tuple([z.string(), z.string(), z.string()])
  .parse(process.argv.slice(2));
const audit = auditBundle(auditPath);
const runtime = gatewayRuntime({ observations: Bus, catalogPath, sessionsDir, composed: composedHolder({ bundles: [audit.contract] }) });
// IPC is subscribed before announcing the commit barrier, so the child remains
// alive until the parent delivers SIGKILL, not until a scheduling delay expires.
process.on("message", () => { throw new Error("unexpected parent command"); });
await acquireAppResource(runtime, Effect.gen(function* () {
  const plane = yield* AppLedger;
  const generations = yield* GenerationLayers;
  yield* generations.initialize({ resident: [], child: [] });
  seedKernelPolicyRows(plane.catalog.policies);
  const entered = yield* Deferred.make<void>();
  const held = yield* Deferred.make<void>();
  const handle = yield* session({ id: "crash-session", role: "resident", bundles: ["audit-log"],
    runner: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held)), Effect.as({ kind: "result" as const, text: "unused" })),
  }, { approvalPolicy: APPROVAL_POLICY, authorizeConfigure: allowConfigure, openKernel: plane.openKernel, listSessions: plane.listSessions });
  yield* Effect.forkIn(handle.prompt("hold g1"), yield* AppScope);
  yield* Deferred.await(entered);
  yield* handle.system.blocks.set([{ id: "next", source: "test", content: "generation-two" }]);
}));
await runAppEffect(runtime, Effect.gen(function* () {
  const plane = yield* AppLedger;
  const kernel = plane.openKernel("crash-session");
  process.send?.({ type: "configured", generation: kernel.latestGenerationFor("crash-session").generation,
    openTurns: kernel.openTurnsPage("crash-session").length, acquisitions: audit.acquired.length });
}));
