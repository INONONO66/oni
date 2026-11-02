import { effectFailure } from "../../../../../packages/channels/test/helpers/effect-failure.js";
import { beforeEach, expect, test } from "bun:test";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
} from "./_router-fixture.js";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

test.each([
  { activation: { durableSessionId: "attacker-session" } },
  { meta: { channelGrantId: "spoof-grant", channelGrantKind: "trusted_channel" } },
  { inboundTreatment: "evidence_only" },
  { senderTier: "owner" },
  { addressee: "bot" },
])("facts-only ingest rejects reserved fields: %j", async (reserved) => {
  expect(await effectFailure(
    kernelRouter().ingest(ownerSender, { ...ownerFacts, ...reserved }),
  )).toMatchObject({
    issues: [expect.objectContaining({ code: "unrecognized_keys" })],
  });
  expect(commits).toEqual([]);
});

test("authenticated surface must match the facts surface", async () => {
  expect(await effectFailure(
    kernelRouter().ingest({ ...ownerSender, surface: "telegram" }, ownerFacts),
  )).toMatchObject({ _tag: "ChannelsFailure", operation: "message.ingress" });
  expect(commits).toEqual([]);
});
