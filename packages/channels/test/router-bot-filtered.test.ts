import { beforeEach, expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { ledger } from "./helpers/ledger";
import { runEffect } from "./helpers/effect";
import { inboundIdOf } from "../src/router/inbound-id";
import { matchPerimeterRules } from "../src/automation/rules";
import {
  commits,
  makeRouter,
  ownerFacts,
  ownerSender,
  resetRouterState,
  routingDecisions,
} from "./router/_router-fixture";

beforeEach(resetRouterState);

test("webhook bot authors are eligible while reactions remain filtered", () => {
  const webhook = Ingress.Input.parse({
    eventId: "webhook:event", surface: "webhook", event: "webhook",
    channelId: "hook", author: { externalId: "automation", isBot: true },
    dm: false, mentionsBot: false, body: "payload", receivedAt: 0,
  });
  expect(matchPerimeterRules(webhook, 0)).toBeUndefined();
  expect(matchPerimeterRules({ ...webhook, event: "reaction" }, 0))
    .toMatchObject({ reason: "reaction_unrouted" });
  // #1569 lane 9c: an A2A peer is an agent admitted by its declared bearer; the bot-echo rule is not for it.
  const peer = Ingress.Input.parse({
    eventId: "m-1", surface: "a2a", event: "message",
    channelId: "ctx-1", author: { externalId: "scout", isBot: true },
    dm: true, mentionsBot: false, body: "plan the sprint", receivedAt: 0,
  });
  expect(matchPerimeterRules(peer, 0)).toBeUndefined();
  expect(matchPerimeterRules({ ...peer, surface: "telegram" }, 0)).toMatchObject({ reason: "bot_author" });
});

for (const [event, reason, used] of [
  ["message", "bot_author", "author.isBot"],
  ["reaction", "reaction_unrouted", "event"],
] as const) {
  test(`${event} ignored at the router records exactly one filtered fact and no delivery`, async () => {
    const facts = {
      ...ownerFacts,
      event,
      author: { externalId: ownerSender.externalId, isBot: event === "message" },
    };
    expect(await runEffect(makeRouter().ingest(ownerSender, facts))).toEqual({
      status: "blocked_pre",
      reasonCode: reason,
    });
    const decision = routingDecisions()[0];
    expect(routingDecisions()).toHaveLength(1);
    expect(decision).toMatchObject({
      stage: "automation",
      outcome: "record",
      decision: "filtered",
      reason,
      factsUsed: [used],
    });
    expect(decision?.sessionId).toBeUndefined();
    expect(commits).toHaveLength(0);
    const stream = Ingress.routeStreamId({
      surface: facts.surface,
      workspace: facts.workspaceId,
      channel: facts.channelId,
      id: [facts.surface, facts.workspaceId, facts.channelId, facts.eventId]
        .map((part) => encodeURIComponent(part ?? ""))
        .join(":"),
    });
    expect(ledger().sessions.decisionFacts?.head(stream)).toBeUndefined();
    expect(ledger().stores.automations.decisions(inboundIdOf(facts))).toEqual([...routingDecisions()]);
  });
}

test("redelivering an already-filtered eventId writes zero additional journal rows", async () => {
  const facts = {
    ...ownerFacts,
    event: "message" as const,
    author: { externalId: ownerSender.externalId, isBot: true },
  };
  const stream = Ingress.routeStreamId({
    surface: facts.surface,
    workspace: facts.workspaceId,
    channel: facts.channelId,
    id: inboundIdOf(facts),
  });
  const first = await runEffect(makeRouter().ingest(ownerSender, facts));
  const firstRows = ledger().stores.automations.decisions(inboundIdOf(facts));
  const second = await runEffect(makeRouter().ingest(ownerSender, facts));
  const secondRows = ledger().stores.automations.decisions(inboundIdOf(facts));
  expect(first).toEqual({ status: "blocked_pre", reasonCode: "bot_author" });
  expect(second).toEqual({ status: "blocked_pre", reasonCode: "bot_author" });
  expect(firstRows).toHaveLength(1);
  expect(secondRows).toEqual(firstRows);
  expect(ledger().sessions.decisionFacts?.head(stream)).toBeUndefined();
  expect(routingDecisions()).toHaveLength(1);
  expect(commits).toHaveLength(0);
});
