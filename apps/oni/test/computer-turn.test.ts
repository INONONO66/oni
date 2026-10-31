import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { computerTurn } from "../src/bundles/approval-policy/computer-turn";
import { computerEvents } from "../src/bundles/approval-policy/computer-events";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { computerFixture, app, target } from "./helpers/computer";
import { runEffect } from "./helpers/effect";
import { fixtureStopEvidence } from "../../../packages/agent/test/helpers/chat-services";
import { createMachineHost } from "../../../packages/machines/test/helpers/native";
import { eventCollector } from "../../../packages/machines/test/helpers/events";
import { socketPath } from "../../../packages/machines/test/helpers/socket-path";
import { connectIpcClient } from "../../../packages/machines/test/ipc/helpers/native";

function turnInput(f: ReturnType<typeof computerFixture>, signal = new AbortController().signal): Core.SessionRunnerInput {
  return {
    sessionId: "resident", kernel: f.plane.openKernel("resident"), role: "resident",
    turnId: "turn-1", actionId: "action-1", ledger: f.ledger, stopEvidence: fixtureStopEvidence,
    resultId: "result-1", parentActionId: null, boundaryActionId: null, messages: [],
    tools: [], toolsGeneration: 1, toolsHash: "tools", system: "", systemHash: "system",
    policyGeneration: 1, resumeCount: 0, signal,
    boundary: () => Effect.succeed({ messages: [], interrupted: signal.aborted }),
  };
}

test.each([
  ["closed", { status: "ok", closed: true }, undefined],
  ["stale epoch", { status: "refused", reason: "epoch_changed" }, { result: { status: "refused", reason: "epoch_changed" } }],
  ["malformed reply", { status: "malformed" }, { result: expect.objectContaining({ status: "failed" }) }],
  ["unavailable", { status: "ok", closed: true }, { reason: "machine_not_attached" }],
] as const)("turn end reports retained targets after %s", async (name, closeReply, retainedFields) => {
  const f = computerFixture();
  const events = eventCollector();
  const closed: Machine.WindowCloseRequest[] = [];
  const host = await createMachineHost({
    events: events.sink, now: f.policy.now, listen: { unix: socketPath() }, captureInput: f.capture,
    enrollment: (machineId) => ({ machineId, name: "Desk", allowedCapabilities: ["computer.use"], publicKey: "0".repeat(64), enrolledAt: 0 }),
  });
  f.host.get = host.native.get;
  f.host.list = host.native.list;
  if (name === "unavailable") f.host.get = (id) => {
    const { computer: _computer, ...handle } = host.native.get(id);
    return handle;
  };
  const client = await connectIpcClient(host.endpoints.unix ?? "", {
    onRequest: (method, params, respond) => {
      if (method === Machine.WireMethod.AppLaunch)
        respond({ status: "ok", pid: 42, windows: [target, { ...target, windowId: 8 }, { ...target, windowId: 9 }] });
      if (method === Machine.WireMethod.WindowClose) {
        closed.push(Machine.WindowCloseRequest.parse(params));
        respond(closeReply);
      }
    },
  });
  try {
    expect(await client.call(Machine.WireMethod.Attach, {
      machineId: "desk", daemonVersion: "test", platform: "darwin-arm64", offeredAt: 0,
      peer: { kind: "client", contractVersion: Machine.contractVersion }, offeredCapabilities: ["computer.use"],
    })).toMatchObject({ status: "attached" });
    f.grant();
    const computer = host.native.get("desk").computer;
    if (computer === undefined) throw new Error("computer handle missing");
    const runner = computerTurn(f.policy, APPROVAL_POLICY, () => Effect.gen(function* () {
      yield* computer.app.launch({ app: { bundleId: app.bundleId }, activate: false, freshInstance: true })
        .pipe(
          Effect.provideService(Core.ExecutorContext, f.executor),
          Effect.mapError((error) => new Core.AgentFailure({ operation: "test.launch", cause: error.message })),
        );
      f.policy.keep("resident", "turn-1", { machineId: "desk", target, reason: "deliverable" });
      f.policy.keep("resident", "turn-1", { machineId: "desk", target: { ...target, windowId: 8 }, reason: "handoff" });
      return { kind: "result" as const, text: "done" };
    }));
    expect(await runEffect(runner(turnInput(f)).pipe(Effect.provide(f.services)))).toEqual({ kind: "result", text: "done" });
    expect(closed).toEqual(name === "unavailable" ? [] : [{ target: { ...target, windowId: 9 } }]);
    expect(f.actions.map((row) => row.effect.value)).toContainEqual(expect.objectContaining({
      result: { retained: [
        { machineId: "desk", target, launchedBy: { sessionId: "resident", turn: "turn-1" }, keep: "deliverable", reason: "deliverable" },
        { machineId: "desk", target: { ...target, windowId: 8 }, launchedBy: { sessionId: "resident", turn: "turn-1" }, keep: "handoff", reason: "handoff" },
        ...(retainedFields === undefined ? [] : [{
          machineId: "desk", target: { ...target, windowId: 9 },
          launchedBy: { sessionId: "resident", turn: "turn-1" }, ...retainedFields,
        }]),
      ] },
    }));
    expect(f.policy.launched).toEqual([]);
    expect(f.policy.turns.size).toBe(0);
  } finally { await client.close(); await host.close(); f.close(); }
}, 5000);

test("input abort ends leases synchronously and leaves an empty turn with no cleanup action", async () => {
  const f = computerFixture();
  const controller = new AbortController();
  try {
    f.grant();
    const runner = computerTurn(f.policy, APPROVAL_POLICY, () => Effect.sync(() => {
      controller.abort();
      expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "ended", endReason: "stopped" });
      return { kind: "interrupted" as const };
    }));
    expect(await runEffect(runner(turnInput(f, controller.signal)).pipe(Effect.provide(f.services)))).toEqual({ kind: "interrupted" });
    expect(f.actions).toEqual([]);
    expect(f.stopped).toEqual(["desk"]);
  } finally { f.close(); }
});

test("human and private edges update durable lease state before downstream publication", () => {
  const f = computerFixture();
  const seen: Array<Machine.ComputerLease["state"] | undefined> = [];
  const sink = computerEvents(f.policy, {
    publish: () => { seen.push(f.policy.store.get("resident", "desk")?.state); },
    subscribe: () => () => undefined,
  });
  try {
    f.grant();
    sink.publish(Machine.Events.HumanInput, { machineId: "desk", time: 100, at: 100, source: "keyboard" });
    expect(seen).toEqual(["paused"]);
    sink.publish(Machine.Events.Private, { machineId: "desk", time: 101, target, state: "entered" });
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ pauseReason: "private" });
    sink.publish(Machine.Events.Private, { machineId: "desk", time: 102, target, state: "left" });
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ pauseReason: "private" });
    sink.publish(Machine.Events.Detached, { machineId: "desk", time: 103, reason: "connection_closed" });
    expect(f.scheduled.size).toBe(1);
    sink.publish(Machine.Events.Attached, { machineId: "desk", time: 104, effectiveCapabilities: ["computer.use"] });
    expect(f.scheduled.size).toBe(0);
  } finally { f.close(); }
});
