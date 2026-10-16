import { ledger } from "../../helpers/ledger";
import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "../../helpers/effect";
import { effectFailure } from "../../helpers/effect-failure";
import { type Gateway, MessagingEvents, Outbound } from "@openomni/protocol";
import type { ChannelDeliveryRoute } from "../../../src/router";
import { Bus } from "../../helpers/observation";
import { bounded } from "../../helpers/bounded";
import { makeRouter as makeFixtureRouter, resetRouterState } from "../_router-fixture";

/**
 * The identity axis at the send door (#1569 lane 5): a delivery leaves
 * through one instance, `<channel>:<identity>`; the bot is the default and
 * the Owner's account is admitted only from an authenticated Owner-origin
 * turn through an Owner instance whose declaration granted outbound (the
 * mounted `<channel>:owner` route). Every send journals its identity.
 */

interface Delivered {
  readonly route: string;
  readonly externalId: string;
  readonly body: string;
}

const delivered: Delivered[] = [];
const GRANT = {
  id: "grant:resident->owner",
  senderId: "resident",
  targetActorId: "actor-owner",
  operations: ["fire_and_forget" as const],
};

function route(name: string): ChannelDeliveryRoute {
  return async (externalId, payload) => {
    delivered.push({ route: name, externalId, body: Outbound.text(payload) });
    return { value: "accepted" as const };
  };
}

/** The app's prepare for a resident session, with the Owner-origin fact as the test declares it. */
function makeRouter(routes: readonly string[], ownerOrigin: boolean | undefined) {
  return makeFixtureRouter({
    messaging: {
      deliveryRoutes: new Map(routes.map((name) => [name, route(name)])),
      grants: () => [GRANT],
    },
    prepare: (_sender, send, target) =>
      Effect.succeed({
        target,
        ...(ownerOrigin === undefined ? {} : { ownerOrigin }),
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
}

function send(router: ReturnType<typeof makeRouter>, as: "bot" | "owner" | undefined) {
  return runEffect(
    router.ingest(
      { kind: "session", id: "resident" },
      {
        to: { kind: "actor", actorId: "actor-owner", surface: "slack", ...(as === undefined ? {} : { as }) },
        type: "message",
        content: as === "owner" ? "from your account" : "from the bot",
      },
    ),
  );
}

beforeEach(() => {
  resetRouterState();
  delivered.length = 0;
  ledger().stores.actors.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "ep-owner-slack",
    actorId: "actor-owner",
    channel: "slack",
    externalId: "T1:U1",
    workspace: "T1",
  });
});

test("a send with no identity leaves through the bot instance, and an identity-less surface keeps its platform key", async () => {
  const router = makeRouter(["slack:bot", "slack:owner"], undefined);
  expect(await send(router, undefined)).toMatchObject({ status: "executed", delivery: { kind: "actor", value: "accepted" } });
  expect(delivered).toEqual([{ route: "slack:bot", externalId: "T1:U1", body: "from the bot" }]);
  ledger().stores.actors.registerEndpoint({ id: "ep-owner-ws", actorId: "actor-owner", channel: "ws", externalId: "owner" });
  const bare = makeFixtureRouter({
    messaging: { deliveryRoutes: new Map([["ws", route("ws")]]), grants: () => [GRANT] },
  });
  expect(
    await runEffect(
      bare.ingest(
        { kind: "session", id: "resident" },
        { to: { kind: "actor", actorId: "actor-owner", surface: "ws" }, type: "message", content: "loopback" },
      ),
    ),
  ).toMatchObject({ status: "executed" });
  expect(delivered.at(-1)).toEqual({ route: "ws", externalId: "owner", body: "loopback" });
});

test("as: owner from an Owner-origin turn through an outbound-granted Owner instance leaves as the Owner and journals it", async () => {
  const sent = Promise.withResolvers<{ identity: string; endpointId: string }>();
  const stop = Bus.observe((event, data) => {
    if (event.name === MessagingEvents.Sent.name) sent.resolve(MessagingEvents.Sent.schema.parse(data));
  });
  try {
    const router = makeRouter(["slack:bot", "slack:owner"], true);
    expect(await send(router, "owner")).toMatchObject({ status: "executed", delivery: { kind: "actor", value: "accepted" } });
    expect(delivered).toEqual([{ route: "slack:owner", externalId: "T1:U1", body: "from your account" }]);
    expect(await bounded(sent.promise)).toMatchObject({ identity: "owner", endpointId: "ep-owner-slack" });
  } finally {
    stop();
  }
});

test.each([
  ["no Owner-origin fact", true, undefined],
  ["a turn that is not Owner-origin", true, false],
  ["no outbound-granted Owner instance", false, true],
] as const)("as: owner with %s is refused before transport as identity_not_granted", async (_name, ownerRoute, ownerOrigin) => {
  const denied: Gateway.MessageDenialCode[] = [];
  const stop = Bus.observe((event, data) => {
    if (event.name === MessagingEvents.Denied.name) denied.push(MessagingEvents.Denied.schema.parse(data).code);
  });
  try {
    const router = makeRouter(ownerRoute ? ["slack:bot", "slack:owner"] : ["slack:bot"], ownerOrigin);
    expect(await send(router, "owner")).toMatchObject({
      status: "blocked_pre",
      reasonCode: "message.resident.identity_not_granted",
    });
    expect(delivered).toEqual([]);
    // Refused at preflight: nothing reached the send kernel, so no denial event either.
    expect(denied).toEqual([]);
    // The bot identity on the same router is unaffected.
    expect(await send(router, "bot")).toMatchObject({ status: "executed" });
    expect(delivered.map((entry) => entry.route)).toEqual(["slack:bot"]);
  } finally {
    stop();
  }
});

test("a bot send whose platform has only an Owner instance fails closed at transport, never through the Owner's account", async () => {
  const router = makeRouter(["slack:owner"], true);
  expect(
    await effectFailure(
      router.ingest(
        { kind: "session", id: "resident" },
        { to: { kind: "actor", actorId: "actor-owner", surface: "slack" }, type: "message", content: "bot?" },
      ),
    ),
  ).toMatchObject({ _tag: "ChannelsFailure", operation: "message.deliver" });
  expect(delivered).toEqual([]);
});
