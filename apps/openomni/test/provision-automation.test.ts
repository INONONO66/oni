import { afterEach, expect, test } from "bun:test";
import { Ingress, type ToolExecutionContext } from "@openomni/protocol";
import { createProvisionTool, ProvisionInput } from "../src/tools/provision";
import { executeAutomation } from "../src/provisioning/automation";
import { executeProvision } from "../src/provisioning/execution";
import { provisionPort } from "./helpers/provision-port";
import { testPlane } from "./helpers/ledger";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { automationWire } from "../src/composition/automation-wire";
import { runEffect } from "./helpers/effect";

const planes: ReturnType<typeof testPlane>[] = [];
afterEach(() => { for (const plane of planes.splice(0)) plane.close(); });
function fixture() {
  const plane = testPlane();
  planes.push(plane);
  const port = provisionPort(plane);
  if (port.automations === undefined) throw new Error("missing fixture automation store");
  return { plane, port, automations: port.automations };
}
function record(id = "rule") {
  return Ingress.Automation.parse({
    id, name: "Build report", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: "discord", event: "message" }],
    target: "new", kind: "action", instructions: "REPORT_SENTINEL",
  });
}

test("Owner provisioning round trips the record and all mutations share the same store", () => {
  const { automations } = fixture();
  const added = executeAutomation(automations, { op: "automation_add", args: { record: record() } }, "owner");
  expect(added).toMatchObject({ result: { record: { enabled: true, createdBy: "owner" } } });
  expect(executeAutomation(automations, { op: "automation_list", args: {} }, "owner"))
    .toEqual({ op: "automation_list", result: { records: [record()] } });
  expect(executeAutomation(automations, { op: "automation_disable", args: { id: "rule" } }, "owner"))
    .toMatchObject({ result: { record: { enabled: false } } });
  expect(executeAutomation(automations, { op: "automation_enable", args: { id: "rule" } }, "owner"))
    .toMatchObject({ result: { record: { enabled: true } } });
  expect(executeAutomation(automations, { op: "automation_remove", args: { id: "rule" } }, "owner"))
    .toEqual({ op: "automation_remove", result: { id: "rule" } });
});

test("the provision tool lists, disables, and removes as the calling session without approval", async () => {
  const { port, automations } = fixture();
  executeAutomation(automations, { op: "automation_add", args: { record: record() } }, "owner");
  const execute = executeProvision(port, () => 100);
  const context = { sessionId: "agent" } as ToolExecutionContext;
  expect(await execute({ operation: { op: "automation_list", args: {} } }, context))
    .toEqual({ op: "automation_list", result: { records: [record()] } });
  expect(await execute({ operation: { op: "automation_disable", args: { id: "rule" } } }, context))
    .toEqual({ op: "automation_disable", result: { record: { ...record(), enabled: false } } });
  expect(await execute({ operation: { op: "automation_remove", args: { id: "rule" } } }, context))
    .toEqual({ op: "automation_remove", result: { id: "rule" } });
  expect(automations.store.list()).toEqual([]);
});

test("session creation cannot forge authority and every direct enable requests approval", () => {
  const { automations } = fixture();
  const add = { op: "automation_add", args: { record: record() } } as const;
  expect(executeAutomation(automations, add, "session:agent"))
    .toEqual({ op: "automation_add", result: { type: "require_approval", id: "rule" } });
  expect(automations.store.get("rule")).toMatchObject({
    approved: false, record: { createdBy: "session:agent", enabled: false },
  });
  for (let index = 0; index < 2; index += 1)
    expect(executeAutomation(automations, { op: "automation_enable", args: { id: "rule" } }, "session:agent"))
      .toEqual({ op: "automation_enable", result: { type: "require_approval", id: "rule" } });
});

test.each(["approve", "refuse"] as const)("a draft exists before authenticated %s settles the original invocation", async (decision) => {
  const { plane, port, automations } = fixture();
  const { id: _id, ...proposal } = record();
  const f = protectedDispatch(createProvisionTool(port, () => 100), {
    operation: { op: "automation_add", args: { record: proposal } },
  }, undefined, { plane });
  try {
    await bounded(f.opened);
    expect(automations.store.list()).toEqual([expect.objectContaining({
      approved: false, record: expect.objectContaining({ enabled: false, createdBy: `session:${f.identity.sessionId}` }),
    })]);
    const result = await f.answer(decision);
    expect(result.isError === true).toBe(decision === "refuse");
    expect(automations.store.list().map((entry) => [entry.approved, entry.record.enabled]))
      .toEqual([[decision === "approve", decision === "approve"]]);
  } finally {
    await f.close();
  }
});

test("record edits while approval is pending invalidate consent", async () => {
  const { plane, port, automations } = fixture();
  executeAutomation(automations, { op: "automation_add", args: { record: record() } }, "session:agent");
  const f = protectedDispatch(createProvisionTool(port, () => 100), {
    operation: { op: "automation_enable", args: { id: "rule" } },
  }, undefined, { plane });
  try {
    await bounded(f.opened);
    executeAutomation(automations, { op: "automation_add", args: { record: { ...record(), target: "session:elsewhere", enabled: false } } }, "owner");
    await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
    expect(automations.store.get("rule")?.record.enabled).toBe(false);
  } finally {
    await f.close();
  }
});

test("a session cannot replace an Owner-approved id", () => {
  const { automations } = fixture();
  executeAutomation(automations, { op: "automation_add", args: { record: record() } }, "owner");
  expect(executeAutomation(automations, {
    op: "automation_add", args: { record: { ...record(), target: "session:attacker" } },
  }, "session:agent")).toMatchObject({ type: "error", reason: "invalid_record" });
  expect(automations.store.get("rule")?.record.target).toBe("new");
});

test.each(["existing_id", "invalid_regex"] as const)(
  "a %s proposal is a typed tool refusal before opening approval", async (reason) => {
    const { plane, port, automations } = fixture();
    if (reason === "existing_id")
      executeAutomation(automations, { op: "automation_add", args: { record: record() } }, "owner");
    const proposal = reason === "existing_id" ? record() : { ...record(), conditions: { regex: ["["] } };
    const f = protectedDispatch(createProvisionTool(port, () => 100), {
      operation: { op: "automation_add", args: { record: proposal } },
    }, undefined, { plane });
    try {
      expect(await bounded(f.running)).toMatchObject({ isError: true, errorKind: "precondition_failed" });
      expect(f.kernel.requestRows()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("a session wire proposal stays disabled until the Owner enables it", async () => {
  const { automations } = fixture();
  const wire = automationWire(automations);
  expect(await runEffect(wire({
    type: "automation_add", requestId: "session-add", record: record(),
  }, "session:agent"))).toMatchObject({
    type: "automation_add_refused", reason: "require_approval", id: "rule",
  });
  expect(automations.store.get("rule")?.record).toMatchObject({ enabled: false, createdBy: "session:agent" });
  expect(await runEffect(wire({
    type: "automation_enable", requestId: "session-enable", id: "rule",
  }, "session:agent"))).toMatchObject({ type: "automation_enable_refused", reason: "require_approval" });
  expect(await runEffect(wire({
    type: "automation_enable", requestId: "owner-enable", id: "rule",
  }, "owner"))).toMatchObject({ type: "automation_enabled", record: { enabled: true, createdBy: "session:agent" } });
});

test.each(["automation_remove", "automation_enable", "automation_disable"] as const)(
  "%s refuses a missing id with the shared wire reason", async (type) => {
    const { automations } = fixture();
    expect(await runEffect(automationWire(automations)({ type, requestId: "missing", id: "absent" }, "owner")))
      .toMatchObject({ type: `${type}_refused`, requestId: "missing", reason: "not_found", id: "absent" });
  },
);

test("the wire refuses unavailable stores and malformed regex without a partial record", async () => {
  const { automations } = fixture();
  expect(await runEffect(automationWire(undefined)({ type: "automation_list", requestId: "list" }, "owner")))
    .toMatchObject({ type: "automation_list_refused", reason: "store_unconfigured" });
  expect(await runEffect(automationWire(automations)({
    type: "automation_add", requestId: "bad", record: { ...record(), conditions: { regex: ["["] } },
  }, "owner"))).toMatchObject({ type: "automation_add_refused", reason: "invalid_record" });
  expect(automations.store.list()).toEqual([]);
});

test("the actual tool execution preserves session identity on unguarded direct calls", async () => {
  const { port, automations } = fixture();
  const tool = createProvisionTool(port, () => 100);
  const result = await tool.execute(ProvisionInput.parse({
    operation: { op: "automation_add", args: { record: record() } },
  }), { sessionId: "agent", turnId: "turn", callId: "call", signal: new AbortController().signal });
  expect(result).toMatchObject({ result: { type: "require_approval", id: "rule" } });
  expect(automations.store.get("rule")?.record.createdBy).toBe("session:agent");
});
