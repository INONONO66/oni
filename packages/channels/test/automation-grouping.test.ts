import { describe, expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { advanceGroups, match } from "../src/automation/matcher.js";

const record = Ingress.Automation.parse({
  id: "digest", name: "Digest", enabled: true, createdBy: "owner",
  triggers: [{ type: "message", surface: "telegram", event: "message" }],
  target: "session:one", grouping: { by: "channel", windowSeconds: 10 },
});
const input = Ingress.Input.parse({
  eventId: "one", surface: "telegram", event: "message", channelId: "room",
  author: { externalId: "user", isBot: false }, dm: false, mentionsBot: false,
  body: "hello", receivedAt: 0,
});

describe("automation grouping", () => {
  test("three events close once on injected clock advance", () => {
    const first = match([record], input, { now: 0 });
    const second = match([record], { ...input, eventId: "two", receivedAt: 3000 },
      { now: 3000, pending: first.pending });
    const third = match([record], { ...input, eventId: "three", receivedAt: 6000 },
      { now: 6000, pending: second.pending });
    expect([first.route, second.route, third.route]).toEqual([undefined, undefined, undefined]);
    expect(advanceGroups([record], third.pending, 9999).decisions).toHaveLength(0);
    const closed = advanceGroups([record], third.pending, 10000);
    expect(closed.decisions).toHaveLength(1);
    const result = closed.decisions[0]!;
    expect(result.route?.kind).toBe("action");
    if (result.route?.kind === "action") expect(result.route.body.event.messages).toHaveLength(3);
    expect(result.rows.filter((row) => row.stage === "automation" && row.decision === "grouped")).toHaveLength(2);
    expect(advanceGroups([record], closed.pending, 20000).decisions).toHaveLength(0);
  });

  test("a disabled record closes without firing", () => {
    const opened = match([record], input, { now: 0 });
    const closed = advanceGroups([{ ...record, enabled: false }], opened.pending, 10000);
    expect(closed.decisions[0]?.route).toBeUndefined();
    expect(closed.decisions[0]?.rows[0]).toMatchObject({ decision: "filtered", reason: "disabled" });
  });
});
