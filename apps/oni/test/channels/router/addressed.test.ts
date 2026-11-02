import { beforeEach, expect, test } from "bun:test";
import { Delivery, type Ingress } from "@oni/protocol";
import { ledger } from "../../../../../packages/channels/test/helpers/ledger.js";
import { ingressInput, ingressSurfaceKey } from "../../../src/bundles/messaging/automation/input.js";
import { runEffect } from "../../../../../packages/channels/test/helpers/effect.js";
import { commits, makeRouter, resetRouterState, routingDecisions } from "./_router-fixture.js";

const sender = { kind: "external", surface: "slack", externalId: "T1:U-owner" } as const;
const RESIDENT = "T1:U-bot";
const channelFacts: Ingress.Message = {
  eventId: "slack-channel-1", surface: "slack", workspaceId: "T1", channelId: "C-general",
  account: RESIDENT, addressees: [], dm: false, payload: "anyone around?", render: "anyone around?",
};

test.each([
  { name: "DM", facts: { dm: true }, expected: true },
  { name: "account mention", facts: { addressees: [{ externalId: RESIDENT }] }, expected: true },
  { name: "quoted account", facts: { quotes: RESIDENT }, expected: true },
  { name: "another account", facts: { quotes: "other", addressees: [{ externalId: "other" }] }, expected: false },
  { name: "provider verdict", facts: { event: "mention", addressed: true }, expected: false },
  { name: "display label", facts: { context: { quoted: { author: "assistant", text: "quoted" } } }, expected: false },
  { name: "unresolved account", facts: { account: undefined, addressees: [{ externalId: RESIDENT }] }, expected: false },
] satisfies readonly { name: string; facts: Partial<Ingress.Message>; expected: boolean }[])(
  "derives addressed from facts once: $name", ({ facts, expected }) => {
    const derived = ingressInput(ledger().stores, sender, { ...channelFacts, ...facts }, 123);
    expect(derived.addressed).toBe(expected);
    expect(derived.input).toMatchObject({ addressed: expected, from: sender.externalId, receivedAt: 123 });
  },
);

function mount(requireAddressed: boolean): void {
  ledger().stores.actors.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-owner", actorId: "actor-owner", channel: "slack", externalId: sender.externalId, workspace: "T1",
  });
  ledger().stores.actors.registerIdentity({ id: "actor-resident", kind: "resident", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-resident", actorId: "actor-resident", channel: "slack", externalId: RESIDENT, workspace: "T1",
  });
  ledger().stores.rules.add({
    id: "addressed", position: 0, enabled: true, createdBy: "owner",
    when: { instance: "slack", ...(requireAddressed ? { addressed: true } : {}) },
    outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto" },
  });
}

async function ingest(facts: Ingress.Message) {
  return runEffect(makeRouter().ingest(sender, facts));
}

beforeEach(resetRouterState);

test("an unaddressed channel message on a addressed-message rule is filtered before any route", async () => {
  mount(true);
  expect(await ingest(channelFacts)).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(routingDecisions()).toHaveLength(1);
  expect(routingDecisions()[0]).toMatchObject({
    stage: "automation", outcome: "record", decision: "filtered",
    reason: "none", by: "rule/none",
    factsUsed: [],
  });
  expect(commits).toHaveLength(0);
  expect(ledger().stores.rules.decisions(
    "slack:T1:C-general:slack-channel-1".split(":").map(encodeURIComponent).join(":"),
  )).toHaveLength(1);
});

test("a Slack Owner huddle call remains unaddressed under a addressed-message rule", async () => {
  mount(true);
  const call: Ingress.Message = {
    ...channelFacts, eventId: "call:slack:T1:U-owner:1700.1:R1",
    event: "call", receivedBy: "owner", payload: { roomId: "R1", channelId: "C-general" },
  };
  expect(await ingest(call)).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(commits).toHaveLength(0);
});

test("#1600: a message the surface classified as a mention of the bot is addressed, whether or not the bot's account is a registered identity", async () => {
  mount(true);
  // The addressee is not a registered identity: only the surface's own `event: mention` makes this addressed.
  const mentioned: Ingress.Message = { ...channelFacts, eventId: "slack-channel-2", account: "T1:U-unregistered-bot", addressees: [{ externalId: "T1:U-unregistered-bot" }] };
  expect((await ingest(mentioned)).status).toBe("executed");
  expect(routingDecisions().some((decision) => decision.reason === "none")).toBe(false);
});

test("the same message routes when the rule has no addressed constraint", async () => {
  mount(false);
  expect((await ingest(channelFacts)).status).toBe("executed");
  expect(routingDecisions().some((decision) => decision.reason === "none")).toBe(false);
});

test("an addressed postback follows the matching prompt rule without a new routing rule", async () => {
  mount(true);
  const facts: Ingress.Message = {
    ...channelFacts, eventId: "tap-1", event: "postback",
    addressees: [{ externalId: RESIDENT }],
    payload: { type: "block_actions" }, render: "Approve",
    postback: { id: "approve", label: "Approve", messageRef: "sent-1" },
  };
  expect((await ingest(facts)).status).toBe("executed");
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ kind: "prompt" });
  expect(Delivery.text(commits[0]?.content ?? [])).toContain("Approve");
  expect(routingDecisions().some((decision) => decision.reason === "none")).toBe(false);
});

const addressedCases: readonly [string, Ingress.Message][] = [
  ["a DM", { ...channelFacts, eventId: "dm-1", channelId: "D-owner", dm: true }],
  ["a mention", { ...channelFacts, eventId: "mention-1", addressees: [{ externalId: RESIDENT }] }],
  ["a reply quoting the Resident", {
    ...channelFacts, eventId: "quote-1", quotes: RESIDENT,
    reply: { chain: [], replyToMessageId: "m-bot" },
    context: { quoted: { author: "assistant", text: "earlier answer" } },
  }],
];
for (const [label, facts] of addressedCases) {
  test(`${label} routes under a addressed-message rule`, async () => {
    mount(true);
    expect((await ingest(facts)).status).toBe("executed");
    expect(routingDecisions().some((decision) => decision.reason === "none")).toBe(false);
  });
}

test("an Owner mention is addressed on the Owner-account copy", async () => {
  mount(true);
  const friend = { kind: "external", surface: "slack", externalId: "T1:U-friend" } as const;
  const mention = { ...channelFacts, eventId: "owner-mention", addressees: [{ externalId: sender.externalId }] };
  expect(await runEffect(makeRouter().ingest(friend, mention))).toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect((await runEffect(makeRouter().ingest(friend, { ...mention, account: sender.externalId, receivedBy: "owner", eventId: "owner-copy" }))).status).toBe("executed");
});

test("the Owner instance's copy of a message is its own inbound id: the bot's recorded refusal is not replayed against it", async () => {
  const friend = { kind: "external", surface: "slack", externalId: "T1:U-friend" } as const;
  mount(true);

  ledger().stores.actors.registerIdentity({ id: "actor-friend", kind: "human", trustTier: "manager" });
  ledger().stores.actors.registerEndpoint({
    id: "endpoint-friend", actorId: "actor-friend", channel: "slack", externalId: friend.externalId, workspace: "T1",
  });
  const unaddressed: Ingress.Message = { ...channelFacts, eventId: "chatter-1" };
  // The bot's copy is filtered and recorded under the bot's inbound id.
  expect((await runEffect(makeRouter().ingest(friend, unaddressed))).status).toBe("blocked_pre");
  expect(ledger().stores.rules.decisions("slack:T1:C-general:chatter-1")).toHaveLength(1);
  // The Owner's copy carries its own id, so the router decides it afresh (here: the same posture filters it too).
  expect((await runEffect(makeRouter().ingest(friend, { ...unaddressed, receivedBy: "owner" }))).status).toBe("blocked_pre");
  expect(ledger().stores.rules.decisions("slack:T1:C-general:chatter-1:owner")).toHaveLength(1);
});

test("a follow-up in a thread the Resident already answers in routes; a fresh thread does not", async () => {
  mount(true);
  const answered = ingressSurfaceKey({ ...channelFacts, reply: { chain: [], threadId: "1700.1" } });
  ledger().stores.surfaceKeys.claim(answered, "session-thread");
  const followUp: Ingress.Message = {
    ...channelFacts, eventId: "thread-1", reply: { chain: ["1700.1"], threadId: "1700.1" },
  };
  expect((await ingest(followUp)).status).toBe("executed");
  const fresh: Ingress.Message = {
    ...channelFacts, eventId: "thread-2", reply: { chain: ["1800.1"], threadId: "1800.1" },
  };
  expect(await ingest(fresh)).toEqual({ status: "blocked_pre", reasonCode: "none" });
});

test("a quoted non-Resident author does not count as addressing the Resident", async () => {
  mount(true);
  const quote: Ingress.Message = {
    ...channelFacts, eventId: "quote-2",
    reply: { chain: [], replyToMessageId: "m-human" },
    context: { quoted: { author: "@someone", text: "their message" } },
  };
  expect(await ingest(quote)).toEqual({ status: "blocked_pre", reasonCode: "none" });
});
