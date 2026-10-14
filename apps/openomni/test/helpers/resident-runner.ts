import { APPROVAL_POLICY } from "../../src/bundles/approval-policy/index";
import { testToolPorts } from "./tool-ports";
import { Context, Effect, Layer, Scope } from "effect";
import { Bundle, Core } from "@openomni/agent";
const Llm = Core.Llm;
import { LlmLive } from "../../src/runtime";
import { observationService } from "../../../../packages/agent/test/helpers/service-layers";
import type { ObservationSink } from "@openomni/protocol";
import { allowConfigure, generationServices } from "./generation-services";
import type { FixtureLlm } from "./app-fixture";
import { afterEach } from "bun:test";
const closeSessions = Core.closeSessions;
type SessionRuntime = Core.SessionRuntime;
import { Bus } from "./bus";
import { immediateRetryAlarm as nullRetryAlarm } from "./immediate-retry-alarm";
import { createResident, type ResidentOptions } from "../../src/composition/resident";
import { runEffect, runSyncEffect } from "./effect";
import { effectScope } from "./effect-scope";
import { drainSession, localDelivery, resolvedRuntimeFor, testPlane } from "./ledger";
import type { AppLedgerPlane } from "../../src/composition/cluster-runtime";

import { seedKernelPolicyRows } from "../../src/composition/policy";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

export function residentRunner(
  options: Omit<ResidentOptions, "sessionRuntime" | "tools" | "policyGeneration"> & {
    tools: Partial<ResidentOptions["tools"]>;
    llm?: Partial<FixtureLlm>;
    plane?: AppLedgerPlane;
    sessionRuntime?: Partial<SessionRuntime> & {
      readonly clock?: () => number;
      readonly entropy?: () => string;
      readonly observations?: ObservationSink;
    };
  },
) {
  const ownsPlane = options.plane === undefined;
  const plane = options.plane ?? testPlane();
  const runtime: SessionRuntime = {
    approvalPolicy: APPROVAL_POLICY,
    // Resolve on state, never a sleep: these tests exercise retries, not schedules.
    retryAlarm: nullRetryAlarm,
    authorizeConfigure: allowConfigure,
    // #1307: the app composition injects the composed compaction seam; the
    // fixture mirrors that default so compaction-dependent paths stay real.
    compaction: Bundle.compactionCapability().verbs,
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    ...options.sessionRuntime,
  };
  const scope = effectScope();
  seedKernelPolicyRows(plane.catalog.policies);
  const resident = createResident({
    ...options,
    tools: { ...testToolPorts, ...options.tools },
    sessionRuntime: runtime,
    policyGeneration: () => plane.openKernel("policy-probe").currentPolicyGeneration(),
  });
  const fixture = options.sessionRuntime;
  const liveLlm = Context.get(runSyncEffect(Scope.provide(Layer.build(LlmLive), scope.scope)), Llm);
  const context = runSyncEffect(Scope.provide(generationServices({
    clock: fixture?.clock, entropy: fixture?.entropy,
    observations: fixture?.observations === undefined ? Bus : observationService(fixture.observations),
    definitions: resident.definitions, llm: { ...liveLlm, ...options.llm },
    plane,
  }), scope.scope));
  cleanups.push(async () => {
    await runEffect(closeSessions(runtime).pipe(Effect.provide(context)));
    await scope.close();
    if (ownsPlane) plane.close();
  });
  const resolved = resolvedRuntimeFor(runtime, context);
  const drain = (sessionId: string) =>
    scope.run(drainSession({
      plane,
      sessionId,
      runner: resident.runnerFor(plane.openKernel(sessionId).row(sessionId)),
      runtime: resolved,
      scope: scope.scope,
    }).pipe(Effect.provide(context)));
  return {
    ...resident,
    services: context,
    runtime,
    plane,
    drain,
    async prompt(sessionId: string, content: string) {
      const exists = plane.listSessions().some((row) => row.id === sessionId);
      await runEffect(localDelivery(plane, "resident-runner", fixture?.clock ?? Date.now)({
        id: crypto.randomUUID(),
        sessionId,
        kind: "prompt",
        content,
        // Owner prompts enter with the perimeter's recorded full-access treatment (#1245:
        // unknown provenance is evidence-only, so a fixture prompt must declare its authority).
        origin: { encodingVersion: 1, value: { kind: "external", inboundTreatment: "full_access" } },
        createdAt: (fixture?.clock ?? Date.now)(),
        parentActionId: null,
        ...(exists
          ? {}
          : { createSession: resident.genesis(sessionId, null, "resident", "resident") }),
      }));
      const result = await drain(sessionId);
      if (result === undefined) throw new Error("resident turn returned no result");
      return result;
    },
  };
}
