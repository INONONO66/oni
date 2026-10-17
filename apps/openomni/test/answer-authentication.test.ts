import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ownerAnswerAuthentication } from "../src/composition/answer-authentication";
import { registerTrustedChannelGrant } from "../src/gateway";
import { runEffect } from "./helpers/effect";
import { planeFixture } from "./helpers/plane-fixture";

const { channelStores } = planeFixture();

const byToken = (credential: string, requestId: string) => {
  if (credential !== "secret") throw new Error("unauthenticated");
  return { kind: "owner" as const, principalId: "owner", evidenceId: `ws-owner:${requestId}` };
};

test("#1600 lane R3: on a tokenless loopback boot the socket answers a request under the ws bootstrap grant that makes every loopback socket the Owner; another surface, and every token boot, go to the token rule", async () => {
  const stores = channelStores();
  // The production posture: the ws bootstrap grant (loopback only, `assertWsExposure`) and a socket the upgrade named `connection:<uuid>`.
  registerTrustedChannelGrant(stores.channelGrants, { surface: "ws", defaultTier: "owner" });
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
  // A socket the grant does not cover (an allowlist that names others) is no evidence.
  registerTrustedChannelGrant(stores.channelGrants, { surface: "ws", defaultTier: "owner", allowedSenders: ["connection:named"] });
  expect(await runEffect(Effect.flip(tokenless({ kind: "external", surface: "ws", externalId: "connection:abc" }, "", "req-1")))).toMatchObject({
    _tag: "ChannelsFailure",
  });
  registerTrustedChannelGrant(stores.channelGrants, { surface: "ws", defaultTier: "owner" });
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
