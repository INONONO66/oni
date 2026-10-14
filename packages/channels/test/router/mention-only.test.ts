import { beforeEach, expect, test } from "bun:test";
import { Channel, type Gateway } from "@openomni/protocol";
import { ledger } from "../helpers/ledger";
import { runEffect } from "../helpers/effect";
import { commits, makeRouter, resetRouterState, routingDecisions } from "./_router-fixture";

const sender = { kind: "external", surface: "slack", externalId: "T1:U-owner" } as const;
const RESIDENT = "T1:U-bot";
const channelFacts: Gateway.IngressFacts = {
  eventId: "slack-channel-1", surface: "slack", workspaceId: "T1", channelId: "C-general",
  addressees: [], dm: false, payload: "anyone around?", render: "anyone around?",
};

function mount(mentionOnly: boolean): void {
  ledger().stores.actors.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-owner", actorId: "actor-owner", channel: "slack", externalId: sender.externalId, workspace: "T1",
  });
  ledger().stores.actors.registerIdentity({ id: "actor-resident", kind: "resident", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-resident", actorId: "actor-resident", channel: "slack", externalId: RESIDENT, workspace: "T1",
  });
  ledger().stores.channelGrants.put({
    id: "grant-slack", surface: "slack", kind: "trusted_channel", defaultTier: "collaborator",
    createdBy: "local-owner", ...(mentionOnly ? { mentionOnly } : {}),
  });
}

async function ingest(facts: Gateway.IngressFacts) {
  return runEffect(makeRouter().ingest(sender, facts));
}

beforeEach(resetRouterState);

test("an unaddressed channel message on a mention-only grant is filtered before any route", async () => {
  mount(true);
  expect(await ingest(channelFacts)).toEqual({ status: "blocked_pre", reasonCode: "mention_only" });
  expect(routingDecisions()).toHaveLength(1);
  expect(routingDecisions()[0]).toMatchObject({
    stage: "automation", outcome: "record", decision: "filtered",
    reason: "mention_only", by: "rule/mention-only",
    factsUsed: ["channel.mentionOnly", "dm", "mentionsBot"],
  });
  expect(commits).toHaveLength(0);
  expect(ledger().stores.automations.decisions(
    "slack:T1:C-general:slack-channel-1".split(":").map(encodeURIComponent).join(":"),
  )).toHaveLength(1);
});

test("the same message routes when the grant carries no posture", async () => {
  mount(false);
  expect((await ingest(channelFacts)).status).toBe("executed");
  expect(routingDecisions().some((decision) => decision.reason === "mention_only")).toBe(false);
});

const addressedCases: readonly [string, Gateway.IngressFacts][] = [
  ["a DM", { ...channelFacts, eventId: "dm-1", channelId: "D-owner", dm: true }],
  ["a mention", { ...channelFacts, eventId: "mention-1", addressees: [{ externalId: RESIDENT }] }],
  ["a reply quoting the Resident", {
    ...channelFacts, eventId: "quote-1",
    reply: { chain: [], replyToMessageId: "m-bot" },
    context: { quoted: { author: "assistant", text: "earlier answer" } },
  }],
];
for (const [label, facts] of addressedCases) {
  test(`${label} routes under a mention-only grant`, async () => {
    mount(true);
    expect((await ingest(facts)).status).toBe("executed");
    expect(routingDecisions().some((decision) => decision.reason === "mention_only")).toBe(false);
  });
}

test("a follow-up in a thread the Resident already answers in routes; a fresh thread does not", async () => {
  mount(true);
  const answered = Channel.SurfaceKey.fromChannel({
    surface: "slack", namespace: "T1", kind: "channel", id: "C-general", threadId: "1700.1",
  });
  ledger().stores.surfaceKeys.claim(answered, "session-thread");
  const followUp: Gateway.IngressFacts = {
    ...channelFacts, eventId: "thread-1", reply: { chain: ["1700.1"], threadId: "1700.1" },
  };
  expect((await ingest(followUp)).status).toBe("executed");
  const fresh: Gateway.IngressFacts = {
    ...channelFacts, eventId: "thread-2", reply: { chain: ["1800.1"], threadId: "1800.1" },
  };
  expect(await ingest(fresh)).toEqual({ status: "blocked_pre", reasonCode: "mention_only" });
});

test("a quoted non-Resident author does not count as addressing the Resident", async () => {
  mount(true);
  const quote: Gateway.IngressFacts = {
    ...channelFacts, eventId: "quote-2",
    reply: { chain: [], replyToMessageId: "m-human" },
    context: { quoted: { author: "@someone", text: "their message" } },
  };
  expect(await ingest(quote)).toEqual({ status: "blocked_pre", reasonCode: "mention_only" });
});
