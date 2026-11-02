import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

const record = {
  id: "alerts", position: 0, enabled: true, createdBy: "owner", seed: true,
  when: { instance: "chat", channel: "alerts", from: ["user"], addressed: true, isBot: false, dm: false, event: "message" },
  judge: "Is this actionable?", group: { windowSeconds: 10, by: "thread" },
  outcome: { kind: "deliver", target: "conversation", agent: "agent", deliveryKind: "action", instructions: "Summarize", reply: "draft", as: "chat", maxRunsPerDay: 12 },
} satisfies Ingress.Rule;

test("round-trips an ordered rule with every optional field", () => {
  expect(Ingress.Rule.parse(record)).toEqual(record);
  for (const target of ["new", "conversation", "session:worker"]) {
    expect(Ingress.Rule.parse({ ...record, outcome: { ...record.outcome, target } }).outcome).toMatchObject({ kind: "deliver", target });
  }
});

test.each([
  { position: -1 }, { position: 0.5 }, { createdBy: "agent" }, { createdBy: "session:" },
  { when: { instance: "chat", from: [] } }, { when: { instance: "" } },
  { when: { instance: "chat", regex: ["urgent"] } },
  { outcome: { ...record.outcome, target: "session:" } }, { outcome: { ...record.outcome, deliveryKind: "reminder" } },
  { outcome: { ...record.outcome, maxRunsPerDay: 0 } }, { outcome: { ...record.outcome, reply: "send" } },
  { group: { windowSeconds: 15, by: "thread" } }, { group: { windowSeconds: 10, by: "author" } },
  { unexpected: true },
])("rejects invalid rule values and removed fields %#", (overrides) => {
  expect(Ingress.Rule.safeParse({ ...record, ...overrides }).success).toBe(false);
});

test.each(["drop", "record"] as const)("a %s outcome contains no delivery fields", (kind) => {
  expect(Ingress.Rule.parse({ ...record, outcome: { kind } }).outcome).toEqual({ kind });
  expect(Ingress.Rule.safeParse({ ...record, outcome: { kind, target: "new" } }).success).toBe(false);
});

const context: Ingress.MatchContext = {
  ruleId: "alerts", when: record.when, verdict: "yes",
  event: { instance: "chat", channel: "alerts", thread: "root", from: "user",
    messages: [{ eventId: "event", body: "outage", receivedAt: 100 }] },
};

test("round-trips match context and bounds grouped evidence", () => {
  expect(Ingress.MatchContext.parse(context)).toEqual(context);
  for (const count of [0, 65]) expect(Ingress.MatchContext.safeParse({ ...context,
    event: { ...context.event, messages: Array.from({ length: count }, () => context.event.messages[0]) },
  }).success).toBe(false);
  expect(Ingress.MatchContext.safeParse({ ...context, verdict: "maybe" }).success).toBe(false);
});
