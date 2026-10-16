import { expect, test } from "bun:test";
import * as barrel from "../src";

test("channels barrel exposes only its runtime public surface", () => {
  expect(Object.keys(barrel).sort()).toEqual([
    "AutomationConfigurationError",
    "AutomationEnableRefused",
    "ChannelProviders",
    "ChannelsFailure",
    "OwnerLogins",
    "OwnerPosture",
    "SendAdmissionConflict",
    "StoredEndpoint",
    "StoredIdentity",
    "Vault",
    "WebSocketHandler",
    "WebhookCredentials",
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
    "createSecretStore",
    "createSurfaceKeyStore",
    "createWebhookProvider",
    "createWebhookSender",
    "decodeChannelFailure",
    "inboundOnce",
    "openChannelStore",
    "resolveChannelGrant",
    "scheduleTickChannel",
    "signWebhookBody",
    "typingPulse",
    "unconfiguredChannelStores",
    "webSocketSenderTier",
  ]);
  expect("WebSocketFrames" in barrel).toBe(false);
  expect("InvalidInbound" in barrel).toBe(false);
});
