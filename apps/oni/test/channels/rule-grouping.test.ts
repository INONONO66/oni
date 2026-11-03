import { describe, expect, test } from "bun:test";
import { Ingress } from "@oni/protocol";
import { advanceGroups, routeRule } from "../../src/bundles/messaging/rule-outcome.js";

const record = Ingress.Rule.parse({
  id: "digest", position: 0, enabled: true, createdBy: "owner",
  when: { instance: "telegram" },
  outcome: { kind: "deliver", target: "session:one", deliveryKind: "action", reply: "none" }, group: { by: "thread", windowSeconds: 10 },
});
const input = Ingress.Message.parse({
  eventId: "one", instance: "telegram", surface: "telegram", event: "message", channelId: "room",
  author: { externalId: "user", isBot: false }, dm: false, addressed: false,
  from: "user", addressees: [], payload: {},
  render: "hello", receivedAt: 0,
});

describe("automation grouping", () => {
  test("three events close once on injected clock advance", () => {
    const first = routeRule(record, input, { pending: [], matchedToday: () => 0, now: 0 });
    const second = routeRule(record, { ...input, eventId: "two", receivedAt: 3000 },
      { matchedToday: () => 0, now: 3000, pending: first.pending });
    const third = routeRule(record, { ...input, eventId: "three", receivedAt: 6000 },
      { matchedToday: () => 0, now: 6000, pending: second.pending });
    expect([first.route, second.route, third.route]).toEqual([undefined, undefined, undefined]);
    expect(advanceGroups([record], third.pending, 9999).decisions).toHaveLength(0);
    const closed = advanceGroups([record], third.pending, 10000);
    expect(closed.decisions).toHaveLength(1);
    const result = closed.decisions[0];
    if (result === undefined) throw new Error("expected one closed decision");
    expect(result.route?.kind).toBe("action");
    if (result.route?.kind === "action") expect(result.route.body.event.messages).toHaveLength(3);
    expect(result.rows.filter((row) => row.stage === "automation" && row.decision === "grouped")).toHaveLength(2);
    expect(advanceGroups([record], closed.pending, 20000).decisions).toHaveLength(0);
  });

  test("a disabled record closes without firing", () => {
    const opened = routeRule(record, input, { pending: [], matchedToday: () => 0, now: 0 });
    const closed = advanceGroups([{ ...record, enabled: false }], opened.pending, 10000);
    expect(closed.decisions[0]?.route).toBeUndefined();
    expect(closed.decisions[0]?.rows[0]).toMatchObject({ decision: "filtered", reason: "disabled" });
  });

  test("capacity closes at 64 without dropping the 65th member", () => {
    let pending = routeRule(record, input, { pending: [], matchedToday: () => 0, now: 0 }).pending;
    for (let n = 2; n < 64; n++) {
      pending = routeRule(record, { ...input, eventId: String(n) }, { matchedToday: () => 0, now: 0, pending }).pending;
    }
    const full = routeRule(record, { ...input, eventId: "64" }, { matchedToday: () => 0, now: 0, pending });
    expect(full.rows).toEqual([expect.objectContaining({ inboundId: "64", decision: "grouped" })]);
    const closed = advanceGroups([record], full.pending, 0);
    expect(closed.decisions[0]?.route?.kind).toBe("action");
    const route = closed.decisions[0]?.route;
    if (route?.kind === "action") expect(route.body.event.messages).toHaveLength(64);
    expect(closed.pending).toHaveLength(0);
    const next = routeRule(record, { ...input, eventId: "65" }, { matchedToday: () => 0, now: 0, pending: closed.pending });
    expect(next.pending[0]?.inputs).toHaveLength(1);
    expect(advanceGroups([record], next.pending, 10000).decisions[0]?.rows).toHaveLength(1);
  });
});
