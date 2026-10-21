import { expect, test } from "bun:test";
import type { ChannelDeliveryRoute } from "@oni/channels";
import type { Provisioning } from "@oni/protocol";
import { ownerContactFor } from "../src/composition/owner-contact";

const person = (
  id: string,
  trustTier: Provisioning.Person["trustTier"],
  endpoints: readonly { channel: string; externalId: string }[],
): Provisioning.Person => ({
  id,
  displayName: id,
  kind: "human",
  trustTier,
  endpoints: endpoints.map((endpoint) => ({ ...endpoint })),
  revision: 0,
  createdBy: "owner",
  updatedAt: 0,
});

const route: ChannelDeliveryRoute = async () => ({ value: "accepted" });
const routes = (...keys: readonly string[]) => new Map(keys.map((key) => [key, route] as const));

test("#1600 lane R2: a drafted answer goes to the owner-tier Person on a platform whose bot writes a person cold, a live platform before ws", () => {
  const owner = person("person:owner", "owner", [
    { channel: "ws", externalId: "owner" },
    { channel: "github", externalId: "ino" },
    { channel: "instagram", externalId: "ig-owner" },
    { channel: "slack", externalId: "T1:U1" },
    { channel: "telegram", externalId: "7" },
  ]);
  const buyer = person("person:buyer", "collaborator", [{ channel: "slack", externalId: "T1:U9" }]);
  // GitHub's identity-less route posts into an issue, never to a login; Instagram is reached through the Owner's account alone: Slack's bot carries the draft.
  expect(ownerContactFor([buyer, owner], routes("ws", "github", "instagram:owner", "slack:bot", "telegram:bot"))).toEqual({
    actorId: "person:owner",
    surface: "slack",
  });
  // Only the socket: it carries the draft, since the Owner has nothing else.
  expect(ownerContactFor([owner], routes("ws", "github"))).toEqual({ actorId: "person:owner", surface: "ws" });
});

test("#1600 lane R2: a platform where the Owner holds two endpoints is skipped — the actor target names a surface, and two endpoints on it are ambiguous", () => {
  const owner = person("person:owner", "owner", [
    { channel: "slack", externalId: "T1:U1" },
    { channel: "slack", externalId: "T2:U2" },
    { channel: "telegram", externalId: "7" },
  ]);
  expect(ownerContactFor([owner], routes("slack:bot", "telegram:bot"))).toEqual({ actorId: "person:owner", surface: "telegram" });
  expect(ownerContactFor([owner], routes("slack:bot"))).toBeUndefined();
});

test("#1600 lane R2: no owner-tier Person, or none the bot can write to, keeps the draft in the session", () => {
  const owner = person("person:owner", "owner", [{ channel: "kakaotalk", externalId: "k-1" }, { channel: "github", externalId: "ino" }]);
  expect(ownerContactFor([person("person:buyer", "collaborator", [{ channel: "slack", externalId: "T1:U9" }])], routes("slack:bot"))).toBeUndefined();
  expect(ownerContactFor([owner], routes("kakaotalk:owner", "github", "slack:bot"))).toBeUndefined();
  expect(ownerContactFor([], routes("ws"))).toBeUndefined();
});
