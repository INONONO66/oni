import { expect, test } from "bun:test";
import { Ingress } from "@oni/protocol";
import { routeRule } from "../../src/bundles/messaging/rule-outcome.js";
import { match } from "../../../../packages/channels/src/router/automation/match.js";
import { runEffect } from "../../../../packages/channels/test/helpers/effect.js";

test("an event held by the first rule cannot fire a later rule", async () => {
  const input = Ingress.Message.parse({
    eventId: "one", instance: "telegram", surface: "telegram", event: "message", channelId: "room", threadId: "root",
    author: { externalId: "user", isBot: false }, dm: false, addressed: false, render: "alert", receivedAt: 0,
    from: "user", addressees: [], payload: {},
  });
  const first: Ingress.Rule = {
    id: "group", position: 0, enabled: true, createdBy: "owner", when: { instance: "telegram" },
    group: { by: "thread", windowSeconds: 10 }, outcome: { kind: "deliver", target: "session:one", deliveryKind: "action", reply: "none" },
  };
  const selected = await runEffect(match(input, [first, { ...first, id: "immediate", position: 1, group: undefined }]));
  const held = routeRule(selected?.rule, input, { now: 0, pending: [], matchedToday: () => 0 });
  expect(selected?.rule.id).toBe("group");
  expect(held.route).toBeUndefined();
  expect(held.pending).toHaveLength(1);
  expect(held.rows).toEqual([expect.objectContaining({ inboundId: "one", decision: "grouped", by: "rule/group" })]);
});
