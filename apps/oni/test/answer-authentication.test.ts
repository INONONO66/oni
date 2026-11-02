import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ownerAnswerAuthentication } from "../src/composition/answer-authentication";
import { runEffect } from "./helpers/effect";
import { planeFixture } from "./helpers/plane-fixture";

const { channelStores } = planeFixture();

const byToken = (credential: string, requestId: string) => {
  if (credential !== "secret") throw new Error("unauthenticated");
  return { kind: "owner" as const, principalId: "owner", evidenceId: `ws-owner:${requestId}` };
};

test("tokenless loopback sockets authenticate independently of inbound rules; named peers and token boots require credentials", async () => {
  const stores = channelStores();
  // The socket upgrade is confined to loopback by assertWsExposure.
  const tokenless = ownerAnswerAuthentication({ wsToken: undefined, stores, byToken });
  expect(await runEffect(tokenless({ kind: "external", surface: "ws", externalId: "connection:abc" }, "", "req-1"))).toEqual({
    kind: "owner",
    principalId: "owner",
    evidenceId: "ws-loopback:connection:abc:req-1",
  });
  expect(await runEffect(Effect.flip(tokenless({ kind: "external", surface: "slack", externalId: "connection:abc" }, "", "req-1")))).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "answer.authenticate",
  });
  stores.actors.registerIdentity({ id: "peer", kind: "human", trustTier: "collaborator" });
  stores.actors.registerEndpoint({ id: "peer", actorId: "peer", channel: "ws", externalId: "connection:abc" });
  expect(await runEffect(Effect.flip(tokenless({ kind: "external", surface: "ws", externalId: "connection:abc" }, "", "req-1")))).toMatchObject({
    _tag: "ChannelsFailure",
  });
  // With a token configured the Owner's socket is no evidence: the token is.
  const withToken = ownerAnswerAuthentication({ wsToken: "secret", stores, byToken });
  expect(await runEffect(Effect.flip(withToken({ kind: "external", surface: "ws", externalId: "owner" }, "", "req-2")))).toMatchObject({
    _tag: "ChannelsFailure",
  });
  expect(await runEffect(withToken({ kind: "external", surface: "ws", externalId: "owner" }, "secret", "req-2"))).toEqual({
    kind: "owner",
    principalId: "owner",
    evidenceId: "ws-owner:req-2",
  });
});
