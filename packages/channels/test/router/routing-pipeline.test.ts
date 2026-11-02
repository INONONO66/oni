import { expect, test } from "bun:test";
import type { Gateway } from "@oni/protocol";
import { resolveKernelRoute } from "../../src/router/routing-resolution.js";
import { Route } from "../../src/automation/matcher.js";

const event: Gateway.DeliveredEvent = {
  id: "message", traceId: "trace", surface: "chat", mode: "direct",
  meta: { actor: { actorId: "owner", trustTier: "owner" } },
};
const route = Route.parse({
  kind: "prompt", target: "conversation", ruleId: "allow", reply: "auto", newSession: true, conversation: true,
  origin: { eventId: "message", instance: "chat", surface: "chat", event: "message", author: { externalId: "person", isBot: false },
  from: "person", addressees: [], payload: {}, channelId: "room",
    dm: true, addressed: true, render: "hello", receivedAt: 1 },
});

test("a matched rule retains canonical identity and the selected session", () => {
  expect(resolveKernelRoute(event, { list: () => [] }, 1, route, "conversation-session").decision).toMatchObject({
    outcome: "route", stage: "surface_default", sessionId: "conversation-session", actorId: "owner", trustTier: "owner",
    factsUsed: ["rule:allow"], target: "session:conversation-session",
  });
});

test("registered identity alone grants no route without a matching rule", () => {
  expect(resolveKernelRoute(event, { list: () => [] }, 1)).toMatchObject({
    requestExecution: { kind: "none" }, decision: { outcome: "record", by: "rule/none", reason: "none" },
  });
});
