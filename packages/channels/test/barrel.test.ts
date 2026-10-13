import { expect, test } from "bun:test";
import * as barrel from "../src";

test("channels barrel exposes only its runtime public surface", () => {
  expect(Object.keys(barrel).sort()).toEqual([
    "ChannelProviders",
    "ChannelsFailure",
    "SendAdmissionConflict",
    "StoredEndpoint",
    "StoredIdentity",
    "Vault",
    "WebSocketHandler",
    "createActorRegistry",
    "createBlacklistStore",
    "createChannelGrantStore",
    "createChannelInstanceStore",
    "createChannelStores",
    "createEgressBudgetStore",
    "createGatewayRouter",
    "createPersonStore",
    "createReplyGrantStore",
    "createSecretStore",
    "createSurfaceKeyStore",
    "createWebhookProvider",
    "decodeChannelFailure",
    "openChannelStore",
    "resolveChannelGrant",
    "unconfiguredChannelStores",
  ]);
  expect("WebSocketFrames" in barrel).toBe(false);
  expect("InvalidInbound" in barrel).toBe(false);
});
