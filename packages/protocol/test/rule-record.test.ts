import { expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";

const record: Ingress.Rule = {
  id: "alerts", position: 0, enabled: true, createdBy: "owner", seed: true,
  when: { instance: "chat", channel: "alerts", from: ["user"], addressed: true, isBot: false, dm: false, event: "message" },
  judge: "Is this actionable?", group: { windowSeconds: 10, by: "thread" },
  then: { target: "conversation", agent: "agent", kind: "action", instructions: "Summarize", reply: "draft", as: "chat", maxRunsPerDay: 12 },
};

test("round-trips an ordered rule with every optional field", () => {
  expect(Ingress.Rule.parse(record)).toEqual(record);
  for (const target of ["new", "conversation", "session:worker"]) {
    expect(Ingress.Rule.parse({ ...record, then: { ...record.then, target } }).then.target).toBe(target);
  }
});

test.each([
  { position: -1 }, { position: 0.5 }, { createdBy: "agent" }, { createdBy: "session:" },
  { when: { instance: "chat", from: [] } }, { when: { instance: "" } },
  { when: { instance: "chat", regex: ["urgent"] } },
  { then: { ...record.then, target: "session:" } }, { then: { ...record.then, kind: "reminder" } },
  { then: { ...record.then, maxRunsPerDay: 0 } }, { then: { ...record.then, reply: "send" } },
  { group: { windowSeconds: 15, by: "thread" } }, { group: { windowSeconds: 10, by: "author" } },
  { unexpected: true },
])("rejects invalid rule values and removed fields %#", (overrides) => {
  expect(Ingress.Rule.safeParse({ ...record, ...overrides }).success).toBe(false);
});

test("retains the closed grouping windows", () => {
  for (const window of [0, 5, 10, 20, 30, 60] as const) expect(Ingress.WindowSeconds.parse(window)).toBe(window);
  expect(Ingress.WindowSeconds.safeParse(61).success).toBe(false);
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
