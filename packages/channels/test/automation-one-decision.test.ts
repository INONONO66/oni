import { expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { match } from "../src/automation/matcher.js";

test("an event held by a grouping window cannot also fire another trigger", () => {
  const input = Ingress.Input.parse({
    eventId: "one", surface: "telegram", event: "message", channelId: "room",
    author: { externalId: "user", isBot: false }, dm: false, mentionsBot: false,
    body: "alert", receivedAt: 0,
  });
  const first = Ingress.Automation.parse({
    id: "group", name: "Group", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: "telegram", event: "message" }],
    grouping: { by: "channel", windowSeconds: 10 }, target: "session:one",
  });
  const second = { ...first, id: "immediate", grouping: undefined };
  const held = match([first, second], input, { now: 0 });
  expect(held.route).toBeUndefined();
  expect(held.pending).toHaveLength(1);
  expect(held.rows).toHaveLength(0);
});
