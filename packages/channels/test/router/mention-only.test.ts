import { beforeEach, expect, test } from "bun:test";
import { Channel, type Gateway } from "@oni/protocol";
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

test("a Slack Owner huddle call remains unaddressed under a mention-only grant", async () => {
  mount(true);
  const call: Gateway.IngressFacts = {
    ...channelFacts, eventId: "call:slack:T1:U-owner:1700.1:R1",
    event: "call", receivedBy: "owner", payload: { roomId: "R1", channelId: "C-general" },
  };
  expect(await ingest(call)).toEqual({ status: "blocked_pre", reasonCode: "mention_only" });
  expect(commits).toHaveLength(0);
});

test("#1600: a message the surface classified as a mention of the bot is addressed, whether or not the bot's account is a registered identity", async () => {
  mount(true);
  // The addressee is not a registered identity: only the surface's own `event: mention` makes this addressed.
  const mentioned: Gateway.IngressFacts = { ...channelFacts, eventId: "slack-channel-2", event: "mention", addressees: [{ externalId: "T1:U-unregistered-bot" }] };
  expect((await ingest(mentioned)).status).toBe("executed");
  expect(routingDecisions().some((decision) => decision.reason === "mention_only")).toBe(false);
});

test("the same message routes when the grant carries no posture", async () => {
  mount(false);
  expect((await ingest(channelFacts)).status).toBe("executed");
  expect(routingDecisions().some((decision) => decision.reason === "mention_only")).toBe(false);
});

test("an addressed postback follows the ordinary prompt grant without a new routing rule", async () => {
  mount(true);
  const facts: Gateway.IngressFacts = {
    ...channelFacts, eventId: "tap-1", event: "postback",
    addressees: [{ externalId: RESIDENT }],
    payload: { type: "block_actions" }, render: "Approve",
    postback: { id: "approve", label: "Approve", messageRef: "sent-1" },
  };
  expect((await ingest(facts)).status).toBe("executed");
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ kind: "prompt" });
  expect(commits[0]?.content).toContain("Approve");
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

test("a mention of the Owner is addressed where an Owner instance reads the platform, whichever instance observed it; elsewhere a mention-only grant filters it (#1569 lane 6)", async () => {
  const friend = { kind: "external", surface: "slack", externalId: "T1:U-friend" } as const;
  // A registered manager: admitted at top level by tier, so only the posture decides.
  const mountWithFriend = (ownerIntake: boolean) => {
    mount(true);
    ledger().stores.channelGrants.put({
      id: "grant-slack", surface: "slack", kind: "trusted_channel", defaultTier: "manager",
      createdBy: "local-owner", mentionOnly: true, ...(ownerIntake ? { ownerIntake } : {}),
    });
    ledger().stores.actors.registerIdentity({ id: "actor-friend", kind: "human", trustTier: "manager" });
    ledger().stores.actors.registerEndpoint({
      id: "endpoint-friend", actorId: "actor-friend", channel: "slack", externalId: friend.externalId, workspace: "T1",
    });
  };
  const ownerMention: Gateway.IngressFacts = {
    ...channelFacts, eventId: "owner-mention-1", render: "<@U-owner> can you look?",
    payload: "<@U-owner> can you look?", addressees: [{ externalId: sender.externalId }],
  };
  // No Owner instance reads slack: the Owner is not the Resident, so the channel posture filters it.
  mountWithFriend(false);
  expect(await runEffect(makeRouter().ingest(friend, ownerMention))).toEqual({
    status: "blocked_pre", reasonCode: "mention_only",
  });
  // An Owner instance reads slack: both copies of the one message are addressed and route.
  for (const copy of [ownerMention, { ...ownerMention, receivedBy: "owner" as const }]) {
    resetRouterState();
    mountWithFriend(true);
    expect(await runEffect(makeRouter().ingest(friend, copy))).toMatchObject({ status: "executed" });
    expect(routingDecisions().some((decision) => decision.reason === "mention_only")).toBe(false);
  }
});

test("the Owner instance's copy of a message is its own inbound id: the bot's recorded refusal is not replayed against it", async () => {
  const friend = { kind: "external", surface: "slack", externalId: "T1:U-friend" } as const;
  mount(true);
  ledger().stores.channelGrants.put({
    id: "grant-slack", surface: "slack", kind: "trusted_channel", defaultTier: "manager",
    createdBy: "local-owner", mentionOnly: true, ownerIntake: true,
  });
  ledger().stores.actors.registerIdentity({ id: "actor-friend", kind: "human", trustTier: "manager" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-friend", actorId: "actor-friend", channel: "slack", externalId: friend.externalId, workspace: "T1",
  });
  const unaddressed: Gateway.IngressFacts = { ...channelFacts, eventId: "chatter-1" };
  // The bot's copy is filtered and recorded under the bot's inbound id.
  expect((await runEffect(makeRouter().ingest(friend, unaddressed))).status).toBe("blocked_pre");
  expect(ledger().stores.automations.decisions("slack:T1:C-general:chatter-1")).toHaveLength(1);
  // The Owner's copy carries its own id, so the router decides it afresh (here: the same posture filters it too).
  expect((await runEffect(makeRouter().ingest(friend, { ...unaddressed, receivedBy: "owner" }))).status).toBe("blocked_pre");
  expect(ledger().stores.automations.decisions("slack:T1:C-general:chatter-1:owner")).toHaveLength(1);
});

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
