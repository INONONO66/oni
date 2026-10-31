import { Core } from "@oni/agent";
import type { MachineHost, MachineInputCapture } from "@oni/machines";
import { LedgerAction, Machine } from "@oni/protocol";
import { Effect } from "effect";
import { ComputerPolicy } from "../../src/bundles/approval-policy/computer-policy";
import { computerStore } from "../../src/bundles/approval-policy/computer-store";
import { computerCapture } from "../../src/bundles/approval-policy/computer-capture";
import { approvalPolicyBundle } from "../../src/bundles/approval-policy";
import { gateRowPolicySeeds } from "../../src/bundles/core-policy";
import { APPROVAL_POLICY } from "../../src/composition/policy";
import { policySnapshot } from "../../../../packages/agent/test/helpers/compiled-policy";
import { executorLayer } from "../../../../packages/agent/test/helpers/service-layers";
import { nullRetryAlarm } from "../../../../packages/agent/test/helpers/effect-g1";
import { testPlane } from "./ledger";
import { runEffect, runSyncEffect } from "./effect";

export const target = { pid: 42, windowId: 7, epoch: 0 };
export const app = { bundleId: "com.example.Editor", path: "/usr/bin/editor" };
export const observed: Machine.ScreenObserveResult = {
  status: "ok", target, observationId: "o1", lineage: "w42-7-0",
  window: { ...target, app, title: "Editor" }, private: false, complete: true, elements: [],
};
export const textInput: MachineInputCapture = {
  machineId: "desk", generation: 1, method: Machine.WireMethod.InputText,
  params: { requestId: "1-1", captureId: "cap-1", text: "hello", delivery: "background" },
  binding: { ...target, app },
};

export function computerFixture() {
  let now = 100;
  const plane = testPlane({ now: () => now });
  const stopped: string[] = [];
  const scheduled = new Map<number, () => void>();
  let timer = 0;
  let machine: Machine.Info[] = [{
    machineId: "desk", name: "Desk", publicKey: "0".repeat(64), enrolledAt: 0,
    allowedCapabilities: ["computer.use"], capabilities: ["computer.use"], pendingCapabilities: [],
    tags: [], os: "darwin", arch: "arm64",
  }];
  const host: Pick<MachineHost, "list" | "computer" | "get"> = {
    list: () => machine.map((row) => ({ ...row, generation: 1, peer: { kind: "client", contractVersion: 3 } })),
    computer: { close: (machineId) => { stopped.push(machineId); } },
    get: () => { throw new Error("this fixture has no attached transport"); },
  };
  const policy = new ComputerPolicy(computerStore(plane.policyState), {
    now: () => now, host: () => host,
    exclusions: [],
    scheduler: { schedule: (delay, callback) => {
      timer += 1;
      const id = timer;
      const deadline = now + delay;
      scheduled.set(id, () => { now = deadline; callback(); });
      return () => { scheduled.delete(id); };
    } },
  });
  policy.turns.set("resident", "turn-1");
  const bundle = approvalPolicyBundle(() => policy.guard);
  const binding = policySnapshot({
    registry: { ...Core.KERNEL_POLICY_REGISTRY, guards: [{ name: "approval-policy/computer-use", ...policy.guard }] },
    generation: 1, mandatory: [],
    rows: [
      ...Core.SEEDED_POLICY_ROWS,
      ...gateRowPolicySeeds({ rows: bundle.rows, handlers: new Map() }),
    ].map((row) => ({ ...row, generation: 1 })),
  });
  const actions: LedgerAction.Node[] = [];
  const ledger = {
    commit(input: LedgerAction.Append) {
      const action = LedgerAction.Node.parse({ ...input, ordinal: actions.length + 1 });
      actions.push(action);
      return Effect.succeed({ action, revision: action.ordinal });
    },
  };
  const services = executorLayer({
    policy: binding, clock: () => now, entropy: () => `computer-${actions.length + 1}`, observations: { publish: () => undefined },
  });
  const executor = runSyncEffect(Core.createExecutor({
    approvalPolicy: APPROVAL_POLICY, ledger, retryAlarm: nullRetryAlarm,
    identity: { sessionId: "resident", role: "resident", turnId: "turn-1", parentActionId: "turn-1" },
  }).pipe(Effect.provide(services)));
  const capture = computerCapture(policy);
  return {
    plane, host, policy, binding, actions, ledger, services, executor, stopped, scheduled,
    capture,
    call: (request = textInput) => runEffect(capture(request, Effect.succeed({ status: "ok" } as const)).pipe(Effect.provideService(Core.ExecutorContext, executor))),
    grant(patch: Partial<Extract<Machine.ComputerLease, { state: "active" }>> = {}) {
      return policy.store.put({
        sessionId: "resident", machineId: "desk", apps: [app.bundleId], expiresAt: 600_100,
        state: "active", revision: (policy.store.get("resident", "desk")?.revision ?? 0) + 1, ...patch,
      });
    },
    setClock: (time: number) => { now = time; },
    setMachines: (rows: Machine.Info[]) => { machine = rows; },
    setSession: (session: Machine.Session) => {
      machine = machine.map((row) => ({ ...row, live: {
        reportedAt: now, load: { loadAvg1: 0, memoryAvailableBytes: 1, inFlight: 0 }, stale: false, session,
      } }));
    },
    close: () => plane.close(),
  };
}
