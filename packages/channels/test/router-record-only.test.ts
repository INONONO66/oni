import { beforeEach, expect, test } from "bun:test";
import { Ingress } from "@oni/protocol";
import { ledger } from "./helpers/ledger";
import { runEffect } from "./helpers/effect";
import { inboundIdOf } from "../src/router/inbound-id";
import {
  commits,
  makeRouter,
  ownerFacts,
  ownerSender,
  resetRouterState,
  routingDecisions,
} from "./router/_router-fixture";

beforeEach(resetRouterState);


for (const event of ["message", "reaction"] as const) {
  test(`${event} ignored at the router records exactly one filtered fact and no delivery`, async () => {
    const facts = {
      ...ownerFacts,
      event,
      author: { externalId: ownerSender.externalId, isBot: event === "message" },
    };
    expect(await runEffect(makeRouter().ingest(ownerSender, facts))).toEqual({
      status: "blocked_pre",
      reasonCode: "none",
    });
    const decision = routingDecisions()[0];
    expect(routingDecisions()).toHaveLength(1);
    expect(decision).toMatchObject({
      stage: "automation",
      outcome: "record",
      decision: "filtered",
      reason: "none",
      factsUsed: [],
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
    expect(ledger().sessions.decisionFacts?.head(stream)?.data).toMatchObject({ by: "rule/none", outcome: "record" });
    expect(ledger().stores.rules.decisions(inboundIdOf(facts))).toEqual([...routingDecisions()]);
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
  const firstRows = ledger().stores.rules.decisions(inboundIdOf(facts));
  const second = await runEffect(makeRouter().ingest(ownerSender, facts));
  const secondRows = ledger().stores.rules.decisions(inboundIdOf(facts));
  expect(first).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(second).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(firstRows).toHaveLength(1);
  expect(secondRows).toEqual(firstRows);
  expect(ledger().sessions.decisionFacts?.head(stream)?.data).toMatchObject({ by: "rule/none", outcome: "record" });
  expect(routingDecisions()).toHaveLength(1);
  expect(commits).toHaveLength(0);
});
