import { expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { AutomationView } from "../src/renderer/automation/view";
import { GatewayUnavailableError } from "../src/renderer/errors";
import { automationRenderer } from "./helpers/automation-renderer";
import { automationRecord, createAutomationFixture } from "./helpers/automation-wire";

test.each(["timeout", "malformed"] as const)("list controls recover after an automation %s", async (failure) => {
  let hold = true;
  const fixture = createAutomationFixture([automationRecord], [], (request) => hold && request.type === "rule_disable" ? "hold" : undefined);
  const ui = automationRenderer();
  jest.useFakeTimers();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    const sent = fixture.nextRequest();
    await ui.click("Disable");
    const request = await sent;
    expect([...ui.host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    await act(async () => {
      if (failure === "timeout") jest.advanceTimersByTime(15_000);
      else fixture.sockets[0]?.deliverRaw(JSON.stringify({ type: "rule_disabled", requestId: request.requestId, record: null }));
    });
    expect(ui.client.getMutationCache().getAll().at(-1)?.state.error).toBeInstanceOf(GatewayUnavailableError);
    expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
    expect([...ui.host.querySelectorAll("button")].every((button) => !button.disabled)).toBe(true);
    hold = false;
    await ui.click("Disable");
    expect(fixture.records.get(automationRecord.id)?.enabled).toBe(false);
  } finally {
    for (const socket of fixture.sockets) socket.close();
    jest.useRealTimers();
    await ui.close();
  }
});

test("local validation associates nested issues with their controls before sending", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.field("Instance", "");
    await ui.field("From", "valid\n");
    await ui.field("Maximum runs per day", "0");
    await ui.submit();
    for (const label of ["Instance", "From", "Maximum runs per day"]) {
      const field = [...ui.host.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === label);
      const control = field?.querySelector("input,textarea");
      const error = field?.querySelector('[role="alert"]');
      expect(error).not.toBeNull();
      expect(control?.getAttribute("aria-invalid")).toBe("true");
      expect(control?.getAttribute("aria-describedby")?.split(" ")).toContain(error?.id);
    }
    expect(fixture.requests.map((request) => request.type)).toEqual(["rule_list"]);
  } finally { await ui.close(); }
});

test("server invalid_record issues use the same field locations and retain unbound issues", async () => {
  const issues = [
    { path: ["when", "instance"], message: "Surface unavailable", code: "custom" },
    { path: ["when", "from", 0], message: "Channel unavailable", code: "custom" },
    { path: ["args", "record", "outcome", "maxRunsPerDay"], message: "Limit refused", code: "custom" },
    { path: [], message: "Record refused", code: "custom" },
  ];
  const fixture = createAutomationFixture([automationRecord], [], (request) => request.type === "rule_add"
    ? { type: "rule_add_refused", requestId: request.requestId, reason: "invalid_record", detail: "Invalid record", issues }
    : undefined);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.submit();
    for (const [label, issue] of [["Instance", issues[0]], ["From", issues[1]], ["Maximum runs per day", issues[2]]] as const) {
      const field = [...ui.host.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === label);
      expect(field?.querySelector('[role="alert"]')?.textContent).toBe(issue?.message);
      expect(field?.querySelector("input,textarea")?.getAttribute("aria-invalid")).toBe("true");
    }
    expect(ui.host.querySelector('form > [role="alert"]')?.textContent).toContain(issues[3]?.message);
    expect(fixture.requests.map((request) => request.type)).toEqual(["rule_list", "rule_add", "rule_list"]);
  } finally { await ui.close(); }
});

test("pending approval is explicit and Owner approval rereads enabled state", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, enabled: false, createdBy: "session:worker" }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    expect(ui.host.querySelector('[data-record-id="alerts"]')?.textContent).toContain("Pending approval");
    expect([...ui.host.querySelectorAll("button")].find((button) => button.textContent === "Approve and enable")?.disabled).toBe(false);
    await ui.click("Edit");
    expect(ui.host.querySelector('[aria-label="Approval required"]')).not.toBeNull();
    expect([...ui.host.querySelectorAll("button")].some((button) => button.textContent === "Approve and enable")).toBe(false);
    await ui.click("Cancel");
    await ui.click("Approve and enable");
    expect(fixture.requests.map((request) => request.type)).toEqual(["rule_list", "rule_enable", "rule_list"]);
    expect(fixture.records.get("alerts")?.enabled).toBe(true);
    expect(ui.host.querySelector('[data-record-id="alerts"]')?.textContent).not.toContain("Pending approval");
    expect([...ui.host.querySelectorAll("button")].some((button) => button.textContent === "Disable")).toBe(true);
  } finally { await ui.close(); }
});

test("editing a pending proposal cannot enable it through rule_add", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, enabled: false, createdBy: "session:worker" }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.field("Instance", "revised");
    await ui.submit();
    expect(fixture.requests.find((request) => request.type === "rule_add")).toMatchObject({
      record: { enabled: false, createdBy: "session:worker", when: { instance: "revised" } },
    });
    expect([...ui.host.querySelectorAll("button")].some((button) => button.textContent === "Approve and enable")).toBe(true);
  } finally { await ui.close(); }
});

test("approval stays pending until the authoritative reread completes", async () => {
  const record = { ...automationRecord, enabled: false, createdBy: "session:worker" };
  const fixture = createAutomationFixture([record], [], (request) => request.type === "rule_enable" ? "hold" : undefined);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    const requested = fixture.nextRequest();
    await ui.click("Approve and enable");
    const request = await requested;
    expect(request.type).toBe("rule_enable");
    const approve = [...ui.host.querySelectorAll("button")].find((button) => button.textContent === "Approve and enable");
    expect(approve?.disabled).toBe(true);
    expect(fixture.requests.filter((entry) => entry.type === "rule_list")).toHaveLength(1);
    const enabled = { ...record, enabled: true };
    fixture.records.set(record.id, enabled);
    await act(async () => fixture.sockets[0]?.deliver({ type: "rule_enabled", requestId: request.requestId, record: enabled }));
    expect(fixture.requests.filter((entry) => entry.type === "rule_list")).toHaveLength(2);
    expect([...ui.host.querySelectorAll("button")].some((button) => button.textContent === "Disable" && !button.disabled)).toBe(true);
  } finally { await ui.close(); }
});

test.each(["require_approval", "invalid_record", "not_found"] as const)("renders %s refusal inline without optimistic enabling", async (reason) => {
  const fixture = createAutomationFixture([{ ...automationRecord, enabled: false }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    fixture.refuse(reason);
    await ui.click("Enable");
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain(reason);
    expect(fixture.records.get("alerts")?.enabled).toBe(false);
    expect(fixture.requests.at(-1)?.type).toBe("rule_list");
  } finally { await ui.close(); }
});

test.each([
  ["new", "prompt"], ["new", "action"], ["session:existing", "prompt"], ["session:existing", "action"],
] as const)("round trips target %s and kind %s through the form", async (target, kind) => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  const sessions = [{ id: "local", durableSessionId: "existing", title: "Existing", titleSource: "prompt" as const, projectId: null, createdAt: 0, lastActivityAt: 0, unread: false, pinned: false, snoozedUntil: null }];
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions, id: () => "new-record" }));
    await ui.click("New automation");
    await ui.field("Instance", "channel:discord:main");
    await ui.field("Target", target);
    await ui.field("Kind", kind);
    await ui.submit();
    expect(fixture.records.get("new-record")).toMatchObject({ outcome: { kind: "deliver", target, deliveryKind: kind } });
    expect(fixture.requests.map((request) => request.type)).toEqual(["rule_list", "rule_add", "rule_list"]);
  } finally { await ui.close(); }
});

test("disable, enable, edit, and confirmed removal all reread the server record", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Disable");
    expect(fixture.records.get("alerts")?.enabled).toBe(false);
    await ui.click("Enable");
    await ui.click("Edit");
    await ui.field("Instance", "updated");
    await ui.field("Grouping window", "20");
    await ui.submit();
    expect(fixture.records.get("alerts")?.group).toEqual({ windowSeconds: 20, by: "thread" });
    expect(fixture.records.get("alerts")?.when.instance).toBe("updated");
    await ui.click("Remove");
    await ui.click("Keep automation");
    expect(fixture.records.has("alerts")).toBe(true);
    await ui.click("Remove");
    await ui.click("Confirm removal");
    expect(fixture.records.has("alerts")).toBe(false);
    expect(fixture.requests.filter((request) => request.type === "rule_list")).toHaveLength(5);
  } finally { await ui.close(); }
});

test("rule fields round-trip through the editor and optional values can be cleared", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, outcome: { ...automationRecord.outcome, target: "session:unlisted" } }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.field("Position", "1");
    await ui.field("Channel", "room");
    await ui.field("From", "first\nsecond");
    await ui.field("Event", "reaction");
    await ui.field("Bot author", "false");
    await ui.field("Direct message", "true");
    await ui.field("Addressed", "false");
    await ui.field("Judge", "JUDGE_SENTINEL");
    await ui.field("Instructions", "INSTRUCTIONS_SENTINEL");
    await ui.field("Maximum runs per day", "4");
    await ui.field("Reply", "draft");
    await ui.field("Reply as instance", "owner-instance");
    await ui.field("Agent id", "agent");
    await ui.submit();
    expect(fixture.records.get("alerts")).toMatchObject({
      position: 1,
      when: { channel: "room", from: ["first", "second"], event: "reaction", isBot: false, dm: true, addressed: false },
      judge: "JUDGE_SENTINEL",
      outcome: { kind: "deliver", target: "session:unlisted", instructions: "INSTRUCTIONS_SENTINEL", maxRunsPerDay: 4, reply: "draft", as: "owner-instance", agent: "agent" },
    });
    await ui.click("Edit");
    for (const label of ["Channel", "From", "Event", "Judge", "Instructions", "Maximum runs per day", "Bot author", "Reply as instance", "Agent id"]) await ui.field(label, "");
    await ui.submit();
    const saved = fixture.records.get("alerts");
    if (saved?.outcome.kind !== "deliver") throw new Error("delivery outcome missing");
    expect(saved?.judge).toBeUndefined();
    expect(saved?.when.channel).toBeUndefined();
    expect(saved?.when.from).toBeUndefined();
    expect(saved?.when.event).toBeUndefined();
    expect(saved?.when.isBot).toBeUndefined();
    expect(saved?.outcome.instructions).toBeUndefined();
    expect(saved?.outcome.maxRunsPerDay).toBeUndefined();
    expect(saved?.outcome.as).toBeUndefined();
    expect(saved?.outcome.agent).toBeUndefined();
  } finally { await ui.close(); }
});

test("seed rows can be disabled but never removed from the editor", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, seed: true }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    expect([...ui.host.querySelectorAll("button")].find((button) => button.textContent === "Remove")?.disabled).toBe(true);
    await ui.click("Disable");
    expect(fixture.records.get("alerts")).toMatchObject({ seed: true, enabled: false });
  } finally { await ui.close(); }
});

test.each(["drop", "record"] as const)("the editor saves a %s outcome without stale delivery fields", async (kind) => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.field("Outcome", kind);
    await ui.submit();
    expect(fixture.records.get("alerts")?.outcome).toEqual({ kind });
  } finally { await ui.close(); }
});

test("disconnected and failed list states remain actionable", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: null, sessions: [], id: () => "new" }));
    expect(ui.host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    fixture.refuse("store_unconfigured");
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("store_unconfigured");
    fixture.refuse(null);
    await ui.click("Retry");
    expect(ui.host.querySelector('[data-record-id="alerts"]')).not.toBeNull();
  } finally { await ui.close(); }
});
