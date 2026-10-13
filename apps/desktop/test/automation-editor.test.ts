import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { AutomationView } from "../src/renderer/automation/view";
import { automationRenderer } from "./helpers/automation-renderer";
import { automationRecord, createAutomationFixture } from "./helpers/automation-wire";

test("an empty trigger list never reaches the wire", async () => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.click("Remove trigger 1");
    await ui.submit();
    expect(fixture.requests.map((request) => request.type)).toEqual(["automation_list"]);
    expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  } finally { await ui.close(); }
});

test("pending approval is explicit and Owner approval rereads enabled state", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, enabled: false, createdBy: "session:worker" }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    expect(ui.host.querySelector('[data-record-id="alerts"]')?.textContent).toContain("Pending approval");
    await ui.click("Edit");
    expect(ui.host.querySelector('[aria-label="Approval required"]')).not.toBeNull();
    expect(ui.host.querySelector('input[type="checkbox"]')).toBeNull();
    await ui.click("Cancel");
    await ui.click("Approve and enable");
    expect(fixture.requests.map((request) => request.type)).toEqual(["automation_list", "automation_enable", "automation_list"]);
    expect(fixture.records.get("alerts")?.enabled).toBe(true);
    expect(ui.host.querySelector('[data-record-id="alerts"]')?.textContent).not.toContain("Pending approval");
    expect([...ui.host.querySelectorAll("button")].some((button) => button.textContent === "Disable")).toBe(true);
  } finally { await ui.close(); }
});

test("editing a pending proposal cannot enable it through automation_add", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, enabled: false, createdBy: "session:worker" }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.field("Name", "Revised proposal");
    await ui.submit();
    expect(fixture.requests.find((request) => request.type === "automation_add")).toMatchObject({
      record: { enabled: false, createdBy: "session:worker", name: "Revised proposal" },
    });
    expect([...ui.host.querySelectorAll("button")].some((button) => button.textContent === "Approve and enable")).toBe(true);
  } finally { await ui.close(); }
});

test("approval stays pending until the authoritative reread completes", async () => {
  const record = { ...automationRecord, enabled: false, createdBy: "session:worker" };
  const fixture = createAutomationFixture([record], [], (request) => request.type === "automation_enable" ? "hold" : undefined);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    const requested = fixture.nextRequest();
    await ui.click("Approve and enable");
    const request = await requested;
    expect(request.type).toBe("automation_enable");
    const approve = [...ui.host.querySelectorAll("button")].find((button) => button.textContent === "Approve and enable");
    expect(approve?.disabled).toBe(true);
    expect(fixture.requests.filter((entry) => entry.type === "automation_list")).toHaveLength(1);
    const enabled = { ...record, enabled: true };
    fixture.records.set(record.id, enabled);
    await act(async () => fixture.sockets[0]?.deliver({ type: "automation_enabled", requestId: request.requestId, record: enabled }));
    expect(fixture.requests.filter((entry) => entry.type === "automation_list")).toHaveLength(2);
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
    expect(fixture.requests.at(-1)?.type).toBe("automation_list");
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
    await ui.field("Target", target);
    await ui.field("Kind", kind);
    await ui.submit();
    expect(fixture.records.get("new-record")).toMatchObject({ target, kind });
    expect(fixture.requests.map((request) => request.type)).toEqual(["automation_list", "automation_add", "automation_list"]);
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
    await ui.field("Name", "Updated alerts");
    await ui.field("Window", "20");
    await ui.field("Group by", "author");
    await ui.submit();
    expect(fixture.records.get("alerts")?.grouping).toEqual({ windowSeconds: 20, by: "author" });
    expect(fixture.records.get("alerts")?.name).toBe("Updated alerts");
    await ui.click("Remove");
    await ui.click("Keep automation");
    expect(fixture.records.has("alerts")).toBe(true);
    await ui.click("Remove");
    await ui.click("Confirm removal");
    expect(fixture.records.has("alerts")).toBe(false);
    expect(fixture.requests.filter((request) => request.type === "automation_list")).toHaveLength(5);
  } finally { await ui.close(); }
});

test.each([
  { type: "schedule", fields: [["Cron expression", "0 9 * * 1-5"], ["Time zone", "Asia/Seoul"]], trigger: { type: "schedule", cron: "0 9 * * 1-5", tz: "Asia/Seoul" } },
  { type: "webhook", fields: [["Secret reference", "secret:hook"]], trigger: { type: "webhook", secretRef: "secret:hook" } },
  { type: "github", fields: [["GitHub event", "pull_request.opened"]], trigger: { type: "github", event: "pull_request.opened" } },
  { type: "message", fields: [["Surface", "slack"], ["Event", "reaction"]], trigger: { type: "message", surface: "slack", event: "reaction" } },
  { type: "on_demand", fields: [], trigger: { type: "on_demand" } },
] as const)("edits $type trigger fields without losing the record identity", async ({ type, fields, trigger }) => {
  const fixture = createAutomationFixture();
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    await ui.field("Trigger type", type);
    for (const [label, value] of fields) await ui.field(label, value);
    await ui.submit();
    expect(fixture.records.get("alerts")?.triggers).toEqual([trigger]);
    expect(fixture.records.size).toBe(1);
  } finally { await ui.close(); }
});

test("round trips conditions, judge question, instructions and limits with optional clearing", async () => {
  const fixture = createAutomationFixture([{ ...automationRecord, target: "session:unlisted" }]);
  const ui = automationRenderer();
  try {
    await ui.render(createElement(AutomationView, { transport: fixture.transport, sessions: [], id: () => "new" }));
    await ui.click("Edit");
    for (const label of ["Channels", "Users", "Threads", "Contains", "Excludes", "Regular expressions"]) await ui.field(label, "first\nsecond");
    await ui.field("Include bots", "true");
    await ui.field("Direct messages", "false");
    await ui.field("Mentions only", "true");
    await ui.field("Run when", "Does the evidence need attention?");
    await ui.field("Instructions", "Review the evidence.");
    await ui.field("Maximum runs per day", "4");
    await ui.click("Add trigger");
    await ui.click("Remove trigger 2");
    await ui.submit();
    expect(fixture.records.get("alerts")).toMatchObject({
      conditions: { channels: ["first", "second"], users: ["first", "second"], threads: ["first", "second"], contains: ["first", "second"], excludes: ["first", "second"], regex: ["first", "second"], includeBots: true, dm: false, mentionOnly: true },
      runWhen: "Does the evidence need attention?", instructions: "Review the evidence.", limits: { maxRunsPerDay: 4 },
      target: "session:unlisted",
    });
    await ui.click("Edit");
    for (const label of ["Channels", "Run when", "Instructions", "Maximum runs per day", "Include bots"]) await ui.field(label, "");
    await ui.submit();
    expect(fixture.records.get("alerts")?.runWhen).toBeUndefined();
    expect(fixture.records.get("alerts")?.instructions).toBeUndefined();
    expect(fixture.records.get("alerts")?.limits).toBeUndefined();
    expect(fixture.records.get("alerts")?.conditions?.channels).toBeUndefined();
    expect(fixture.records.get("alerts")?.conditions?.includeBots).toBeUndefined();
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
