import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Delivery, type Gateway, Outbound } from "@openomni/protocol";
import { createSendMessageTool } from "../src/bundles/messaging/send-message/index";
import { messageFixture } from "./helpers/message-fixture";

/**
 * The identity axis through the real app gateway (#1569 lane 5): a
 * `send_message … as: owner` is admitted only when the sending turn opened
 * on an Owner-tier prompt (the app's `ownerOrigin` fold off the turn's own
 * deliveries and the actor registry) and an Owner instance of the surface
 * grants outbound (its `<surface>:owner` route is mounted); everything else
 * is the compiled `message.resident.identity_not_granted` denial before
 * transport, and a send with no identity leaves as the bot.
 */

interface Delivered {
  readonly route: string;
  readonly externalId: string;
  readonly body: string;
}

function fixtureWith(routes: readonly string[]) {
  const delivered: Delivered[] = [];
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map(
      routes.map((route) => [
        route,
        async (externalId: string, payload: Outbound.Payload) => {
          delivered.push({ route, externalId, body: Outbound.text(payload) });
          return { value: "accepted" as const };
        },
      ]),
    ),
    grants: () => [
      { id: "grant", senderId: "sender", targetActorId: "person:owner", operations: ["fire_and_forget"] },
      { id: "grant-friend", senderId: "sender", targetActorId: "person:friend", operations: ["fire_and_forget"] },
    ],
    // A letter to a friend is outreach: it needs the Owner's declared budget as any send does.
    budgets: () => [
      { id: "budget-friend", targetActorId: "person:friend", maxPerWindow: 10, windowMs: 60_000, cooldownMs: 0 },
    ],
  });
  fixture.plane.stores.actors.registerIdentity({ id: "person:owner", kind: "human", trustTier: "owner" });
  fixture.plane.stores.actors.registerEndpoint({
    id: "slack:owner-endpoint",
    actorId: "person:owner",
    channel: "slack",
    externalId: "T1:U1",
    workspace: "T1",
  });
  fixture.plane.stores.actors.registerIdentity({ id: "person:friend", kind: "human", trustTier: "collaborator" });
  fixture.plane.stores.actors.registerEndpoint({
    id: "slack:friend-endpoint",
    actorId: "person:friend",
    channel: "slack",
    externalId: "T1:U2",
    workspace: "T1",
  });
  return { fixture, delivered };
}

/** The origin a channel prompt from `actorId` carries, as the perimeter records it. */
function promptFrom(actorId: string): Delivery.Origin {
  return {
    encodingVersion: 1,
    value: {
      kind: "external",
      inboundTreatment: "full_access",
      messageId: `slack::${actorId}:1`,
      surface: "slack",
      externalId: actorId === "person:owner" ? "T1:U1" : "T1:U2",
      actorId,
      conversation: { channelId: "D1", messageId: "1710.0001", dm: true, workspaceId: "T1" },
    },
  };
}

const asOwner: Gateway.SendMessage = {
  to: { kind: "actor", actorId: "person:friend", surface: "slack", as: "owner" },
  type: "message",
  content: "from the Owner's account",
};

test("as: owner from an Owner-origin turn through an outbound-granted Owner instance leaves through slack:owner", async () => {
  const { fixture, delivered } = fixtureWith(["slack:bot", "slack:owner"]);
  try {
    const sent = await fixture.send(asOwner, undefined, promptFrom("person:owner"));
    expect(sent.isError).not.toBe(true);
    expect(delivered).toEqual([{ route: "slack:owner", externalId: "T1:U2", body: "from the Owner's account" }]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("as: owner from a turn that is not Owner-origin is refused as identity_not_granted before transport", async () => {
  const { fixture, delivered } = fixtureWith(["slack:bot", "slack:owner"]);
  try {
    const refused = await fixture.send(asOwner, undefined, promptFrom("person:friend"));
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("message.resident.identity_not_granted");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the newest external delivery decides: a sender the registry does not hold, arriving after the Owner in the same turn, is refused", async () => {
  const { fixture, delivered } = fixtureWith(["slack:bot", "slack:owner"]);
  try {
    // The Owner posts in a shared channel; before the turn opens a stranger
    // posts there too. The perimeter records the stranger with no actor.
    await fixture.stage("summarize this thread", promptFrom("person:owner"));
    const stranger: Delivery.Origin = {
      encodingVersion: 1,
      value: {
        kind: "external",
        inboundTreatment: "full_access",
        messageId: "slack::stranger:1",
        surface: "slack",
        externalId: "T1:U9",
        actorId: "",
        conversation: { channelId: "C1", messageId: "1710.0002", dm: false, workspaceId: "T1" },
      },
    };
    const refused = await fixture.send(asOwner, undefined, stranger);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("message.resident.identity_not_granted");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("as: owner without an outbound-granted Owner instance is refused as identity_not_granted, even on an Owner-origin turn", async () => {
  const { fixture, delivered } = fixtureWith(["slack:bot"]);
  try {
    const refused = await fixture.send(asOwner, undefined, promptFrom("person:owner"));
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("message.resident.identity_not_granted");
    expect(delivered).toEqual([]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a send with no identity leaves through the bot instance whatever the turn's origin", async () => {
  const { fixture, delivered } = fixtureWith(["slack:bot", "slack:owner"]);
  try {
    const sent = await fixture.send(
      { to: { kind: "actor", actorId: "person:friend", surface: "slack" }, type: "message", content: "from the bot" },
      undefined,
      promptFrom("person:owner"),
    );
    expect(sent.isError).not.toBe(true);
    expect(delivered).toEqual([{ route: "slack:bot", externalId: "T1:U2", body: "from the bot" }]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the model-facing tool carries `as` onto the gateway send and refuses any other identity", () => {
  const tool = createSendMessageTool(undefined, () => 0);
  expect(tool.input.safeParse({ to: { kind: "contact", id: "person:friend", as: "owner" }, message: "hi" }).success).toBe(true);
  expect(tool.input.safeParse({ to: { kind: "contact", id: "person:friend", as: "admin" }, message: "hi" }).success).toBe(false);
});
