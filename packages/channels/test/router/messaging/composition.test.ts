import { ledger } from "../../helpers/ledger";
import { effectFailure } from "../../helpers/effect-failure";
import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../../helpers/effect";
import { replaceDecisionFacts } from "../../helpers/ledger";
import { type Gateway, Outbound } from "@openomni/protocol";
import type { ChannelDeliveryRoute } from "../../../src/router";
import { makeRouter as makeFixtureRouter, resetRouterState } from "../_router-fixture";

const delivered: Array<{ externalId: string; body: string; idempotencyKey: string }> = [];
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
const reply: Gateway.SendMessage = {
  to: { kind: "actor", actorId: "actor-buyer" },
  type: "message",
  content: "yes",
  deadline: Number.MAX_SAFE_INTEGER,
};

function makeRouter(routes?: ReadonlyMap<string, ChannelDeliveryRoute>) {
  return makeFixtureRouter({
    messaging: {
      deliveryRoutes:
        routes ??
        new Map([
          [
            "discord",
            async (externalId: string, payload: Outbound.Payload, idempotencyKey: string) => {
              delivered.push({ externalId, body: Outbound.text(payload), idempotencyKey });
              return { value: "accepted", externalMessageId: `platform-${delivered.length}` };
            },
          ],
        ]),
      grants: () => [],
      replyGrantRules: () => [
        {
          id: "market",
          senderId: "persona-owner",
          surface: "discord",
          workspace: "shop-ws",
          channel: "market",
          operations: ["awaited"],
          instanceTtlMs: 86_400_000,
          maxLiveInstances: 5,
          createdBy: "owner",
        },
      ],
    },
  });
}

type Router = ReturnType<typeof makeRouter>;

function admitFirstContact(router: Router) {
  return runEffect(router.ingest(sender, facts));
}

function sendActorReply(router: Router) {
  return runEffect(router.ingest({ kind: "session", id: "persona-owner" }, reply));
}

beforeEach(() => {
  resetRouterState();
  delivered.length = 0;
  ledger().stores.channelGrants.put({
    id: "market",
    surface: "discord",
    workspace: "shop-ws",
    channel: "market",
    kind: "broadcast_channel",
    defaultTier: "collaborator",
    createdBy: "owner",
  });
  ledger().stores.actors.registerIdentity({ id: "actor-buyer", kind: "human", trustTier: "collaborator" });
  ledger().stores.actors.registerEndpoint({
    id: "ep-buyer",
    actorId: "actor-buyer",
    channel: "discord",
    externalId: "buyer-external",
    workspace: "shop-ws",
  });
});

test("ungranted actor send is refused before transport", async () => {
  expect(await runEffect(makeRouter().ingest({ kind: "session", id: "persona-owner" }, reply))).toMatchObject({
    status: "blocked_pre",
  });
  expect(delivered).toEqual([]);
});

test("admitted first contact grants a scoped reply through the same ingest", async () => {
  const router = makeRouter();
  expect((await admitFirstContact(router)).status).toBe("executed");
  const sent = await sendActorReply(router);
  expect(sent).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value: "accepted" },
  });
  if (sent.status !== "executed") throw new Error("not executed");
  const request = ledger().kernel.requestRows("persona-owner")[0];
  // W5.2: the deadline wake is a persisted entity DeliverAt message, not an
  // alarm row; the durable fact asserted here is the open request's deadline.
  expect(request).toMatchObject({ deadline: reply.deadline, state: "open" });
  expect(delivered).toEqual([
    { externalId: "buyer-external", body: "yes", idempotencyKey: sent.handle.messageId },
  ]);
});

test("a granted endpoint without a channel delivery owner fails closed", async () => {
  const router = makeRouter(new Map());
  await admitFirstContact(router);
  expect(await effectFailure(router.ingest({ kind: "session", id: "persona-owner" }, reply))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.deliver" });
  expect(delivered).toEqual([]);
});

test("an admission denied after preflight fails as a typed send-admission conflict", async () => {
  const suppressed = makeFixtureRouter({
    messaging: {
      deliveryRoutes: new Map([
        [
          "discord",
          async (externalId: string, payload: Outbound.Payload, idempotencyKey: string) => {
            delivered.push({ externalId, body: Outbound.text(payload), idempotencyKey });
            return { value: "accepted" as const };
          },
        ],
      ]),
      grants: () => [
        {
          id: "grant:owner->buyer",
          senderId: "persona-owner",
          targetActorId: "actor-buyer",
          operations: ["fire_and_forget", "awaited"],
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
  expect(await effectFailure(suppressed.ingest({ kind: "session", id: "persona-owner" }, reply))).toMatchObject({
    _tag: "SendAdmissionConflict",
  });
  expect(delivered).toEqual([]);
});

test("restart reads the durable live-grant projection, never route history", async () => {
  await admitFirstContact(makeRouter());
  replaceDecisionFacts((facts: import("@openomni/protocol").Storage.DecisionFactSubAdapter) => ({
    ...facts,
    head: (key: string) => {
      if (key.startsWith("route:")) throw new Error("route replay is forbidden");
      return facts.head(key);
    },
  }));
  const restarted = makeRouter();
  expect(await sendActorReply(restarted)).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value: "accepted" },
  });
});

test("historical route facts cannot reconstruct authority on restart", async () => {
  ledger().sessions.decisionFacts?.record({
    key: "route:forged",
    type: "route.decided",
    data: { outcome: "route", actorId: "actor-buyer" },
    timeCreated: 1,
  });
  expect(await sendActorReply(makeRouter())).toMatchObject({
    status: "blocked_pre",
  });
  expect(delivered).toEqual([]);
});

test("endpoint rebinding invalidates a durable reply grant", async () => {
  await admitFirstContact(makeRouter());
  ledger().stores.actors.registerEndpoint({
    id: "ep-buyer",
    actorId: "actor-buyer",
    channel: "discord",
    externalId: "other-container",
    workspace: "shop-ws",
  });
  expect(await sendActorReply(makeRouter())).toMatchObject({
    status: "blocked_pre",
  });
  expect(delivered).toEqual([]);
});

test.each([
  "accepted",
  "rejected",
  "unknown",
] as const)("actor %s receipt survives the composed router", async (value: "accepted" | "rejected" | "unknown") => {
  const router = makeRouter(new Map([["discord", async () => ({ value })]]));
  await admitFirstContact(router);
  expect(await sendActorReply(router)).toMatchObject({
    status: "executed",
    delivery: { kind: "actor", value },
  });
});
