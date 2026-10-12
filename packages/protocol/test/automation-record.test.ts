import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

const triggers = [
  { type: "schedule", cron: "0 9 * * *", tz: "UTC" },
  { type: "message", surface: "discord", event: "message" },
  { type: "message", surface: "discord", event: "reaction" },
  { type: "message", surface: "discord", event: "mention" },
  { type: "webhook", secretRef: "secret-1" },
  { type: "github", event: "issues.opened" },
  { type: "on_demand" },
] as const satisfies readonly Ingress.Trigger[];

for (const trigger of triggers) {
  test(`round-trips ${trigger.type} trigger`, () => {
    expect(Ingress.Trigger.parse(trigger)).toEqual(trigger);
  });
}

const record = {
  id: "automation-1",
  name: "Alerts",
  enabled: false,
  createdBy: "session:agent-1",
  triggers: [...triggers],
  conditions: {
    channels: ["alerts", "incident"],
    users: ["user-1"],
    threads: ["thread-1"],
    contains: ["outage"],
    excludes: ["resolved"],
    regex: ["^critical"],
    includeBots: true,
    dm: false,
    mentionOnly: false,
  },
  runWhen: "Is this actionable?",
  grouping: { windowSeconds: 10, by: "thread" },
  target: "new",
  instructions: "Summarize the incident",
  limits: { maxRunsPerDay: 12 },
};

test("defaults the agent-created record kind to action", () => {
  const parsed = Ingress.Automation.parse(record);
  expect(parsed.kind).toBe("action");
  expect(parsed.createdBy).toBe("session:agent-1");
  expect(parsed.triggers).toEqual([...triggers]);
  expect(Ingress.Automation.parse({ ...record, enabled: true }).enabled).toBe(true);
  expect(Ingress.Automation.parse({ ...record, kind: "prompt", target: "session:x" }).kind).toBe("prompt");
});

test("rejects unknown fields and invalid windows at every nested boundary", () => {
  expect(Ingress.Automation.safeParse({ ...record, unexpected: "raw" }).success).toBe(false);
  expect(Ingress.Automation.safeParse({ ...record, grouping: { windowSeconds: 15, by: "thread" } }).success).toBe(false);
  expect(Ingress.Automation.safeParse({ ...record, grouping: { windowSeconds: 5, by: "author", raw: true } }).success).toBe(false);
  expect(Ingress.Automation.safeParse({ ...record, conditions: { channels: ["x"], raw: true } }).success).toBe(false);
  expect(Ingress.Automation.safeParse({ ...record, limits: { maxRunsPerDay: 0 } }).success).toBe(false);
  expect(Ingress.Automation.safeParse({ ...record, triggers: [] }).success).toBe(false);
  expect(Ingress.Trigger.safeParse({ type: "on_demand", cron: "* * * * *" }).success).toBe(false);
});

test("exposes the closed window and conditions contracts", () => {
  for (const window of [0, 5, 10, 20, 30, 60] as const) expect(Ingress.WindowSeconds.parse(window)).toBe(window);
  expect(Ingress.WindowSeconds.safeParse(61).success).toBe(false);
  expect(Ingress.Conditions.parse(record.conditions)).toEqual(record.conditions);
});

const context: Ingress.TriggerContext = {
  automationId: "automation-1",
  trigger: triggers[2],
  matched: { conditions: record.conditions, runWhen: { verdict: "unknown", reason: "insufficient context" } },
  event: {
    surface: "discord",
    channelId: "alerts",
    threadId: "thread-1",
    author: { externalId: "bot-1", isBot: true },
    messages: [{ eventId: "event-1", body: "outage", receivedAt: 1_750_000_000_000 }],
  },
};

test("round-trips an unknown judge verdict and bounds grouped messages", () => {
  expect(Ingress.TriggerContext.parse(context)).toEqual(context);
  expect(Ingress.TriggerContext.safeParse({ ...context, event: { ...context.event, messages: [] } }).success).toBe(false);
  expect(Ingress.TriggerContext.safeParse({ ...context, event: { ...context.event, messages: Array.from({ length: 65 }, () => context.event.messages[0]) } }).success).toBe(false);
  expect(Ingress.TriggerContext.safeParse({ ...context, event: { ...context.event, raw: "payload" } }).success).toBe(false);
  expect(Ingress.TriggerContext.safeParse({ ...context, matched: { ...context.matched, runWhen: { verdict: "maybe", reason: "x" } } }).success).toBe(false);
});
