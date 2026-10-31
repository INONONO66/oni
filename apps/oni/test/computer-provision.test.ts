import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { Machine, type ToolExecutionContext } from "@oni/protocol";
import { createProvisionTool } from "../src/bundles/provision/provision";
import { executeComputer, computerDomainRevisions } from "../src/bundles/provision/computer";
import type { ComputerOperation } from "../src/bundles/provision/computer-schema";
import { computerFixture, textInput, target, app } from "./helpers/computer";
import { provisionPort } from "./helpers/provision-port";
import { protectedDispatch, bounded } from "./helpers/protected-dispatch";

const context: ToolExecutionContext = {
  sessionId: "resident", turnId: "turn-1", callId: "request", signal: new AbortController().signal,
};
const request = {
  op: "computer_request",
  args: { machineId: "desk", apps: [app.bundleId], clipboard: "none", minutes: 10, foreground: { purpose: "Review output" } },
} satisfies ComputerOperation;

test("Owner approval grants ten minutes and expired foreground calls refuse on the same gate", async () => {
  const f = computerFixture();
  const definition = createProvisionTool({ ...provisionPort(f.plane), computer: f.policy }, f.policy.now);
  const dispatch = protectedDispatch(definition, { operation: request }, undefined, {
    plane: f.plane, computer: f.policy, sessionId: "resident",
  });
  try {
    const opened = await bounded(dispatch.opened);
    expect(opened.parsedInput).toEqual({ operation: request });
    expect(f.policy.store.get("resident", "desk")).toBeUndefined();
    expect((await dispatch.answer()).structuredContent).toMatchObject({
      op: "computer_request", result: { state: "active", expiresAt: 600_100, foreground: { expiresAt: 600_100 } },
    });
    const foreground = { ...textInput, params: { requestId: "1-2", captureId: "cap-1", text: "hello", delivery: "foreground" as const } };
    expect(await f.call(foreground)).toEqual({ status: "ok" });
    f.setClock(600_100);
    expect(await f.call(foreground)).toEqual({ status: "refused", reason: "lease_expired" });
  } finally { await dispatch.close(); f.close(); }
});

test("unapproved and stale requests cannot create authority while lists and end are session-scoped", () => {
  const f = computerFixture();
  try {
    expect(() => executeComputer(undefined, request, context)).toThrow(Core.ToolRefused);
    expect(executeComputer(f.policy, request, context)).toEqual({
      op: "computer_request", result: { type: "require_approval", id: "desk" },
    });
    const revisions = computerDomainRevisions(f.policy, "resident", request);
    f.grant();
    expect(() => executeComputer(f.policy, request, { ...context, domainRevisions: revisions })).toThrow(Core.ToolRefused);
    const exclusion = { op: "computer_exclude", args: { machineId: "desk", app: "/secret" } } as const;
    expect(executeComputer(f.policy, exclusion, context)).toMatchObject({ result: { type: "require_approval" } });
    expect(executeComputer(f.policy, exclusion, { ...context, domainRevisions: {} })).toEqual({ op: "computer_exclude", result: exclusion.args });
    expect(executeComputer(f.policy, { op: "computer_list", args: {} }, context)).toMatchObject({
      result: { leases: [{ sessionId: "resident", state: "active" }], exclusions: [exclusion.args] },
    });
    expect(executeComputer(f.policy, { op: "computer_list", args: {} }, { ...context, sessionId: "other" }))
      .toMatchObject({ result: { leases: [] } });
    expect(executeComputer(f.policy, { op: "computer_end", args: { machineId: "missing" } }, context)).toEqual({ op: "computer_end", result: null });
    expect(executeComputer(f.policy, { op: "computer_end", args: { machineId: "desk" } }, context))
      .toMatchObject({ result: { state: "ended", endReason: "owner_ended" } });
  } finally { f.close(); }
});

test.each(["deliverable", "handoff"] as const)("computer_keep records %s only on this turn's launched targets", (reason) => {
  const f = computerFixture();
  try {
    f.grant();
    const operation = { op: "computer_keep", args: { machineId: "desk", target, reason } } as const;
    expect(() => executeComputer(f.policy, operation, context)).toThrow(Core.ToolRefused);
    f.policy.answered("resident", {
      machineId: "desk", generation: 1, method: Machine.WireMethod.AppLaunch,
      params: { app: { path: app.path }, activate: false },
    }, { status: "ok", pid: target.pid, windows: [target] });
    expect(executeComputer(f.policy, operation, context)).toEqual({ op: "computer_keep", result: operation.args });
    expect(f.policy.launched).toEqual([{ machineId: "desk", target, launchedBy: { sessionId: "resident", turn: "turn-1" }, keep: reason }]);
    expect(() => executeComputer(f.policy, operation, { ...context, turnId: "old" })).toThrow(Core.ToolRefused);
    executeComputer(f.policy, { ...operation, args: { ...operation.args, target: target.pid } }, context);
    expect(f.policy.launched[0]?.keep).toBe(reason);
  } finally { f.close(); }
});
