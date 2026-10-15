import { expect, test } from "bun:test";
import * as barrel from "../src";

test("channels barrel exposes only its runtime public surface", () => {
  expect(Object.keys(barrel).sort()).toEqual([
    "AutomationConfigurationError",
    "AutomationEnableRefused",
    "ChannelProviders",
    "ChannelsFailure",
    "SendAdmissionConflict",
    "StoredEndpoint",
    "StoredIdentity",
    "Vault",
    "WebSocketHandler",
    "createActorRegistry",
    "createAutomationStore",
    "createBlacklistStore",
    "createChannelGrantStore",
    "createChannelInstanceStore",
    "createChannelStores",
    "createEgressBudgetStore",
    "createGatewayRouter",
    "createMachineEnrollmentStore",
    "createPersonStore",
    "createReplyGrantStore",
    "createSecretStore",
    "createSurfaceKeyStore",
    "createWebhookProvider",
    "decodeChannelFailure",
    "openChannelStore",
    "resolveChannelGrant",
    "scheduleTickChannel",
    "typingPulse",
    "unconfiguredChannelStores",
    "webSocketSenderTier",
  ]);
  expect("WebSocketFrames" in barrel).toBe(false);
  expect("InvalidInbound" in barrel).toBe(false);
});
