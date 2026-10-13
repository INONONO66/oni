import { beforeEach, expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
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
    expect(ledger().sessions.decisionFacts?.head(stream)).toMatchObject({
      type: "route.decided",
      data: { decision: "filtered", reason },
    });
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
  const firstRow = ledger().sessions.decisionFacts?.head(stream);
  const second = await runEffect(makeRouter().ingest(ownerSender, facts));
  const secondRow = ledger().sessions.decisionFacts?.head(stream);
  expect(first).toEqual({ status: "blocked_pre", reasonCode: "bot_author" });
  expect(second).toEqual({ status: "blocked_pre", reasonCode: "bot_author" });
  // CAS first-write-wins: the redelivery's record() call is an INSERT OR
  // IGNORE on the same key, so the stored row (its hash) is unchanged — the
  // second ingest wrote zero journal rows, not a second row at the same key.
  expect(firstRow?.rowHash).toBeDefined();
  expect(secondRow?.rowHash).toEqual(firstRow?.rowHash);
  expect(commits).toHaveLength(0);
});
