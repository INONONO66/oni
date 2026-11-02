import { ledger } from "../../helpers/ledger";
import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../../helpers/effect";
import { effectFailure } from "../../helpers/effect-failure";
import { Effect } from "effect";
import { type Gateway, Ingress, MessagingEvents, Outbound } from "@oni/protocol";
import { ingressSurfaceKey } from "../../../src/router/automation/input";
import { registerRule } from "../../helpers/rule";
import type { ChannelDeliveryRoute } from "../../../src/router";
import { admitReply } from "../../../src/router/messaging/admission";
import { SendAdmissionConflict } from "../../../src/errors";
import { Bus } from "../../helpers/observation";
import { bounded } from "../../helpers/bounded";
import {
  makeRouter as makeFixtureRouter,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
} from "../_router-fixture";

/**
 * The reply door composed into the router (#1569): a channel message is
 * admitted and routed to a session, which claims the ingress surface key;
 * that session, and only it, may answer the conversation through an
 * origin-targeted send — no grant, no budget, one admission fact per message
 * id, delivery into the channel the person wrote in.
 */

interface Delivered {
  readonly externalId: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly conversation: Gateway.Conversation | undefined;
}

const delivered: Delivered[] = [];
const sender = { kind: "external", surface: "discord", externalId: "buyer-external" } as const;
const facts: Gateway.IngressFacts = {
  eventId: "contact",
  surface: "discord",
  workspaceId: "shop-ws",
  channelId: "market",
  addressees: [],
  dm: false,
  payload: "available?",
  render: "available?",
};
const MARKET_KEY = ingressSurfaceKey(facts, sender.externalId);

const capturing: ChannelDeliveryRoute = { platform: "discord", identity: "bot", deliver: async (
  externalId,
  payload,
  idempotencyKey,
  conversation,
) => {
  delivered.push({ externalId, body: Outbound.text(payload), idempotencyKey, conversation });
  return { value: "accepted", externalMessageId: `platform-${delivered.length}` };
} };

function makeRouter(
  routes: ReadonlyMap<string, ChannelDeliveryRoute> = new Map([["discord", capturing]]),
) {
  return makeFixtureRouter({ messaging: { deliveryRoutes: routes, grants: () => [] } });
}

type Router = ReturnType<typeof makeRouter>;

/** The routed session and the prompt id the person's message became. */
async function admitFirstContact(router: Router) {
  const admitted = await runEffect(router.ingest(sender, facts));
  if (admitted.status !== "executed") throw new Error(`first contact was ${admitted.status}`);
  return admitted.handle;
}

function replyFrom(router: Router, sessionId: string, inReplyTo: string, content = "yes") {
  return runEffect(
    router.ingest(
      { kind: "session", id: sessionId },
      { to: { kind: "origin", inReplyTo }, type: "message", content },
    ),
  );
}

beforeEach(() => {
  resetRouterState();
  delivered.length = 0;
  registerRule({ when: { instance: "discord", channel: "market" } });
  ledger().stores.actors.registerIdentity({
    id: "actor-buyer",
    kind: "human",
    trustTier: "collaborator",
  });
  ledger().stores.actors.registerEndpoint({
    id: "ep-buyer",
    actorId: "actor-buyer",
    channel: "discord",
    externalId: "buyer-external",
    workspace: "shop-ws",
  });
});

test("the session the conversation was routed to answers it through the reply door, in the channel the person wrote in", async () => {
  const sent = Promise.withResolvers<{
    grantId: string;
    endpointId: string;
    targetActorId: string;
    senderId: string;
    messageId: string;
  }>();
  const stop = Bus.observe((event, data) => {
    if (event.name === MessagingEvents.Sent.name)
      sent.resolve(MessagingEvents.Sent.schema.parse(data));
  });
  try {
    const router = makeRouter();
    const prompt = await admitFirstContact(router);
    expect(ledger().stores.surfaceKeys.lookup(MARKET_KEY)).toBe(prompt.target);
    const answered = await replyFrom(router, prompt.target, prompt.messageId);
    expect(answered).toMatchObject({
      status: "executed",
      handle: { target: prompt.target },
      delivery: { kind: "actor", value: "accepted" },
    });
    if (answered.status !== "executed") throw new Error("not executed");
    expect(delivered).toEqual([
      {
        externalId: "buyer-external",
        body: "yes",
        idempotencyKey: answered.handle.messageId,
        conversation: { channelId: "market", threadId: "contact", replyToMessageId: "contact" },
      },
    ]);
    expect(await bounded(sent.promise)).toMatchObject({
      grantId: `binding:${MARKET_KEY}`,
      endpointId: "ep-buyer",
      targetActorId: "actor-buyer",
      senderId: prompt.target,
      messageId: answered.handle.messageId,
    });
    // No grant was consulted and no budget debited: a reply is not outreach.
    expect(ledger().stores.egressBudgets.read(prompt.target, "actor-buyer", 0).countInWindow).toBe(
      0,
    );
  } finally {
    stop();
  }
});

test("two instances keep identical conversation and event ids separate and reply through the receiving instance", async () => {
  const selected: string[] = [];
  const routes = new Map<string, ChannelDeliveryRoute>(["east", "west"].map((slug) => [
    `channel:discord:${slug}`,
    { platform: "discord", identity: "bot", deliver: async () => {
      selected.push(slug);
      return { value: "accepted" };
    } },
  ]));
  const router = makeRouter(routes);
  for (const [position, slug] of ["east", "west"].entries()) {
    registerRule({ id: slug, position: position + 1, when: { instance: `channel:discord:${slug}` } });
  }
  const east = await runEffect(router.ingest(sender, { ...facts, instance: "channel:discord:east" }));
  const west = await runEffect(router.ingest(sender, { ...facts, instance: "channel:discord:west" }));
  if (east.status !== "executed" || west.status !== "executed") throw new Error("instances not admitted");
  expect(west.handle.target).not.toBe(east.handle.target);
  expect((await replyFrom(router, west.handle.target, west.handle.messageId)).status).toBe("executed");
  expect(selected).toEqual(["west"]);
  routes.delete("channel:discord:west");
  expect(await replyFrom(router, west.handle.target, west.handle.messageId)).toMatchObject({
    status: "blocked_pre", reasonCode: "message.resident.reply_unbound",
  });
  expect(selected).toEqual(["west"]);
});

test("a session that never received the prompt binds nothing (the fold refuses), as does an unknown prompt", async () => {
  const router = makeRouter();
  const prompt = await admitFirstContact(router);
  expect(await replyFrom(router, "another-session", prompt.messageId)).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_unbound",
  });
  expect(await replyFrom(router, prompt.target, "never-delivered")).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_unbound",
  });
  expect(delivered).toEqual([]);
});

test("a binding the app folded for a session the router never routed the conversation to is refused by the router itself", async () => {
  const router = makeFixtureRouter({
    messaging: { deliveryRoutes: new Map([["discord", capturing]]), grants: () => [] },
    // An app fold that vouches for a session the surface key does not name.
    prepare: (_sender, send, target) =>
      Effect.succeed({
        target,
        binding: {
          surface: "discord",
          externalId: "buyer-external",
          actorId: "actor-buyer",
          workspaceId: "shop-ws",
          channelId: "market",
          messageId: "contact",
          dm: false,
        },
        message: {
          sender: "session" as const,
          senderRole: "resident" as const,
          targetKind: send.to.kind,
          type: send.type,
          parentChild: true,
          fanout: 0,
          depth: 1,
          withinParentDeadline: true,
        },
      }),
  });
  ledger().stores.surfaceKeys.claim(MARKET_KEY, "the-routed-session");
  expect(await replyFrom(router, "intruder", "contact")).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_unbound",
  });
  expect(delivered).toEqual([]);
});

test("a DM is answered in its chat, unthreaded, and a thread in its thread: the binding folds the same key the inbound claimed", async () => {
  const router = makeRouter();
  registerOwnerDm();
  const dm = await runEffect(router.ingest(ownerSender, ownerFacts));
  if (dm.status !== "executed") throw new Error(`dm was ${dm.status}`);
  expect(await replyFrom(router, dm.handle.target, dm.handle.messageId, "direct")).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value: "accepted" },
  });
  const thread = await runEffect(
    router.ingest(sender, { ...facts, eventId: "in-thread", reply: { chain: [], threadId: "t-1" } }),
  );
  if (thread.status !== "executed") throw new Error(`thread was ${thread.status}`);
  expect(
    await replyFrom(router, thread.handle.target, thread.handle.messageId, "threaded"),
  ).toMatchObject({ status: "executed", delivery: { kind: "actor", value: "accepted" } });
  expect(delivered).toEqual([
    {
      externalId: ownerSender.externalId,
      body: "direct",
      idempotencyKey: delivered[0]?.idempotencyKey ?? "",
      conversation: { channelId: "owner-dm" },
    },
    {
      externalId: "buyer-external",
      body: "threaded",
      idempotencyKey: delivered[1]?.idempotencyKey ?? "",
      conversation: { channelId: "market", threadId: "t-1", replyToMessageId: "in-thread" },
    },
  ]);
});

test("a rule-routed action is answered by the session the ledger routed it to, with no key claimed", async () => {
  const router = makeRouter();
  ledger().stores.actors.registerIdentity({ id: "observer", kind: "human", trustTier: "observer" });
  ledger().stores.actors.registerEndpoint({
    id: "observer-endpoint",
    actorId: "observer",
    channel: ownerSender.surface,
    externalId: ownerSender.externalId,
    workspace: ownerFacts.workspaceId,
  });
  ledger().stores.rules.add(
    Ingress.Rule.parse({
      id: "greeter",
      position: 1,
      enabled: true,
      createdBy: "owner",
      when: { instance: ownerFacts.surface, dm: true },
      outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "auto" },
    }),
  );
  const routed = await runEffect(router.ingest(ownerSender, ownerFacts));
  expect(routed).toMatchObject({ status: "executed", handle: { target: "worker" } });
  if (routed.status !== "executed") throw new Error("not routed");
  const ownerKey = ingressSurfaceKey(ownerFacts, ownerSender.externalId);
  expect(ledger().stores.surfaceKeys.lookup(ownerKey)).toBeUndefined();
  expect(await replyFrom(router, "worker", routed.handle.messageId, "hi")).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value: "accepted" },
  });
  expect(await replyFrom(router, "bystander", routed.handle.messageId, "hi")).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_unbound",
  });
  expect(delivered.map((entry) => [entry.externalId, entry.body])).toEqual([
    [ownerSender.externalId, "hi"],
  ]);
});

test("a reply is never throttled: a do-not-contact budget stops the standing-grant actor send, not the door", async () => {
  // The person's first contact is admitted before the budget exists (a
  // do-not-contact budget also refuses their inbound); the budget then
  // governs the routed session's outbound.
  const prompt = await admitFirstContact(makeRouter());
  const router = makeFixtureRouter({
    messaging: {
      deliveryRoutes: new Map([["discord", capturing]]),
      grants: () => [
        {
          id: "grant:routed->buyer",
          senderId: prompt.target,
          targetActorId: "actor-buyer",
          operations: ["fire_and_forget"],
        },
      ],
      budgets: () => [
        {
          id: "budget:do-not-contact",
          targetActorId: "actor-buyer",
          maxPerWindow: 10,
          windowMs: 60_000,
          cooldownMs: 0,
          doNotContact: true,
        },
      ],
    },
  });
  expect(await replyFrom(router, prompt.target, prompt.messageId)).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value: "accepted" },
  });
  expect(delivered).toHaveLength(1);
  expect(ledger().stores.egressBudgets.read(prompt.target, "actor-buyer", 0).countInWindow).toBe(0);
  expect(
    await effectFailure(
      router.ingest(
        { kind: "session", id: prompt.target },
        { to: { kind: "actor", actorId: "actor-buyer" }, type: "message", content: "cold" },
      ),
    ),
  ).toMatchObject({ _tag: "SendAdmissionConflict" });
  expect(delivered).toHaveLength(1);
});

test("an actor send under a standing grant whose surface has no delivery route fails closed at admission", async () => {
  const router = makeFixtureRouter({
    messaging: {
      deliveryRoutes: new Map(),
      grants: () => [
        {
          id: "grant:owner->buyer",
          senderId: "persona-owner",
          targetActorId: "actor-buyer",
          operations: ["fire_and_forget"],
        },
      ],
    },
  });
  expect(
    await runEffect(
      router.ingest(
        { kind: "session", id: "persona-owner" },
        { to: { kind: "actor", actorId: "actor-buyer" }, type: "message", content: "yes" },
      ),
    ),
  ).toEqual({ status: "blocked_pre", reasonCode: "message.resident.actor_grant" });
  expect(delivered).toEqual([]);
});

test("a route revoked after admission never falls through to another instance", async () => {
  const routes = new Map([["channel:discord:west", capturing], ["channel:discord:east", capturing]]);
  const router = makeFixtureRouter({
    messaging: {
      deliveryRoutes: routes,
      grants: () => [{
        id: "grant", senderId: "persona-owner", targetActorId: "actor-buyer", operations: ["fire_and_forget"],
      }],
    },
    transaction: (operation) => operation.pipe(Effect.tap(() => Effect.sync(() => {
      routes.delete("channel:discord:west");
    }))),
  });
  expect(await effectFailure(router.ingest(
    { kind: "session", id: "persona-owner" },
    { to: { kind: "actor", actorId: "actor-buyer", surface: "channel:discord:west" }, type: "message", content: "yes" },
  ))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.deliver" });
  expect(delivered).toEqual([]);
});

test("an Owner-account rule freezes draft replies until a new inbound matches auto", async () => {
  const ownerDelivered: string[] = [];
  const ownerRoute: ChannelDeliveryRoute = { platform: "discord", identity: "owner", deliver: async (externalId, payload) => {
    ownerDelivered.push(`${externalId}:${Outbound.text(payload)}`);
    return { value: "accepted" };
  } };
  const routes = new Map([["discord:owner", ownerRoute]]);
  registerRule({ id: "owner", position: 1, when: { instance: "discord:owner" },
    outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "draft", as: "discord:owner" } });
  const drafting = makeFixtureRouter({ messaging: { deliveryRoutes: routes, grants: () => [] } });
  const inbound = await runEffect(drafting.ingest(sender, { ...facts, receivedBy: "owner", instance: "discord:owner" }));
  if (inbound.status !== "executed") throw new Error("Owner contact was not admitted");
  const prompt = inbound.handle;
  expect(await replyFrom(drafting, prompt.target, prompt.messageId)).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_draft",
  });
  expect(ownerDelivered).toEqual([]);
  // A later rule edit applies to new inbounds, not an already recorded draft.
  registerRule({ id: "owner", position: 1, when: { instance: "discord:owner" },
    outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto", as: "discord:owner" } });
  const answering = makeFixtureRouter({
    messaging: { deliveryRoutes: routes, grants: () => [] },
  });
  expect((await replyFrom(answering, prompt.target, prompt.messageId)).status).toBe("blocked_pre");
  const fresh = await runEffect(answering.ingest(sender, { ...facts, eventId: "auto-contact", receivedBy: "owner", instance: "discord:owner" }));
  if (fresh.status !== "executed") throw new Error("new Owner contact was not admitted");
  expect((await replyFrom(answering, fresh.handle.target, fresh.handle.messageId, "as the Owner")).status).toBe("executed");
  expect(ownerDelivered).toEqual(["buyer-external:as the Owner"]);
  // Adding a bot never moves the Owner instance's conversation to that bot.
  const withBot = makeFixtureRouter({
    messaging: {
      deliveryRoutes: new Map([["discord:bot", capturing], ["discord:owner", ownerRoute]]),
      grants: () => [],
    },
  });
  expect((await replyFrom(withBot, fresh.handle.target, fresh.handle.messageId, "still the Owner")).status).toBe("executed");
  expect(delivered).toEqual([]);
  expect(ownerDelivered).toEqual(["buyer-external:as the Owner", "buyer-external:still the Owner"]);
});

test("a DM the Owner's account received is answered through the Owner's instance, never the bot (#1600 lane R2)", async () => {
  const ownerDelivered: string[] = [];
  const ownerRoute: ChannelDeliveryRoute = { platform: "discord", identity: "owner", deliver: async (externalId, payload) => {
    ownerDelivered.push(`${externalId}:${Outbound.text(payload)}`);
    return { value: "accepted" };
  } };
  const routes = new Map([["discord:bot", capturing], ["discord:owner", ownerRoute]]);
  registerOwnerDm();
  registerRule({ id: "owner", position: 3, when: { instance: "discord:owner", dm: true },
    outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "draft", as: "discord:owner" } });
  const drafting = makeFixtureRouter({ messaging: { deliveryRoutes: routes, grants: () => [] } });
  const dm = await runEffect(drafting.ingest(ownerSender, { ...ownerFacts, instance: "discord:owner", receivedBy: "owner" }));
  if (dm.status !== "executed") throw new Error(`dm was ${dm.status}`);
  expect(await replyFrom(drafting, dm.handle.target, dm.handle.messageId)).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_draft",
  });
  expect(delivered).toEqual([]);
  expect(ownerDelivered).toEqual([]);
  // An inbound-only Owner instance (no outbound grant, so no route) still drafts: the Owner needs no route to answer from their own account.
  const inboundOnly = makeFixtureRouter({ messaging: { deliveryRoutes: new Map([["discord:bot", capturing]]), grants: () => [] } });
  expect(await replyFrom(inboundOnly, dm.handle.target, dm.handle.messageId)).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_draft",
  });
  expect(delivered).toEqual([]);
  registerRule({ id: "owner", position: 3, when: { instance: "discord:owner", dm: true },
    outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto", as: "discord:owner" } });
  const answering = makeFixtureRouter({
    messaging: { deliveryRoutes: routes, grants: () => [] },
  });
  const fresh = await runEffect(answering.ingest(ownerSender, { ...ownerFacts, eventId: "auto-dm", instance: "discord:owner", receivedBy: "owner" }));
  if (fresh.status !== "executed") throw new Error("new Owner DM was not admitted");
  expect((await replyFrom(answering, fresh.handle.target, fresh.handle.messageId, "as the Owner")).status).toBe("executed");
  expect(ownerDelivered).toEqual([`${ownerSender.externalId}:as the Owner`]);
  expect(delivered).toEqual([]);
  // The same DM observed by the bot is the bot's to answer.
  const seenByBot = await runEffect(answering.ingest(ownerSender, { ...ownerFacts, eventId: "seen-by-bot" }));
  if (seenByBot.status !== "executed") throw new Error(`bot-seen dm was ${seenByBot.status}`);
  expect((await replyFrom(answering, seenByBot.handle.target, seenByBot.handle.messageId, "as the bot")).status).toBe("executed");
  expect(delivered.map((entry) => entry.body)).toEqual(["as the bot"]);
  expect(ownerDelivered).toHaveLength(1);
});

test("a button tap is answered on the message the button was on, not the tap's own id (#1600 lane R2)", async () => {
  const router = makeRouter();
  const tap = await runEffect(
    router.ingest(sender, {
      ...facts,
      eventId: "tap-1",
      payload: "Yes",
      render: "Yes",
      postback: { id: "choice-yes", label: "Yes", messageRef: "offer-message" },
    }),
  );
  if (tap.status !== "executed") throw new Error(`tap was ${tap.status}`);
  expect((await replyFrom(router, tap.handle.target, tap.handle.messageId, "noted")).status).toBe("executed");
  expect(delivered).toEqual([
    {
      externalId: "buyer-external",
      body: "noted",
      idempotencyKey: delivered[0]?.idempotencyKey ?? "",
      conversation: { channelId: "market", threadId: "tap-1", replyToMessageId: "offer-message" },
    },
  ]);
});

test("a conversation whose surface has no delivery route is refused before transport", async () => {
  const router = makeRouter(new Map());
  const prompt = await admitFirstContact(router);
  expect(await replyFrom(router, prompt.target, prompt.messageId)).toMatchObject({
    status: "blocked_pre",
    reasonCode: "message.resident.reply_unbound",
  });
  expect(delivered).toEqual([]);
});

test.each([
  "accepted",
  "rejected",
  "unknown",
] as const)("the surface's %s receipt survives the composed reply door", async (value) => {
  const router = makeRouter(new Map([["discord", { platform: "discord", identity: "bot", deliver: async () => ({ value }) }]]));
  const prompt = await admitFirstContact(router);
  expect(await replyFrom(router, prompt.target, prompt.messageId)).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value },
  });
});

test("the reply admission records one budget-free fact per message id: a replay matches, different content conflicts", () => {
  makeRouter();
  const target: Gateway.DeliveryTarget = {
    instance: "discord",
    actorId: "actor-buyer",
    endpointId: "ep-buyer",
    channel: "discord",
    identity: "bot",
    externalId: "buyer-external",
  };
  const input = (text: string): Gateway.SendInput => ({
    messageId: "reply-1",
    traceId: "trace-1",
    senderId: "session-1",
    target: { actorId: "actor-buyer", endpointId: "ep-buyer", surface: "discord" },
    operation: "fire_and_forget",
    payload: Outbound.payload(text),
    at: 5,
  });
  const first = admitReply(ledger().stores, input("yes"), target);
  expect(first).toMatchObject({ budgeted: false, sendClass: "notify" });
  expect(admitReply(ledger().stores, input("yes"), target)).toEqual(first);
  expect(() => admitReply(ledger().stores, input("no"), target)).toThrow(SendAdmissionConflict);
});
