import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChannelDeliveryRoute, type ProviderTypingRoute, resolveChannelGrant } from "@openomni/channels";
import type { Provisioning } from "@openomni/protocol";
import { MOUNTED_CHANNEL_DEFAULT_TIER, registerTrustedChannelGrant } from "../src/gateway";
import { type ChannelComponent, declaredChannelProfile, validateProviderCredential } from "../src/channels";
import { type DesiredChannels, createChannelSupervisor } from "../src/bundles/provision/supervisor";
import { planeFixture } from "./helpers/plane-fixture";
import { testChannelDeps } from "./helpers/test-entropy";

/**
 * Owner instances in the channel profile and the supervisor (#1569 lane 5):
 * an `identity: owner` declaration builds through the provider's owner arm
 * (or reports `identity_unsupported`), mounts a delivery route only when its
 * `grant.outbound` says so, and never registers an ingress grant; routes key
 * by instance surface id while grants and webhook paths key by platform.
 */

const { plane, channelStores } = planeFixture();

function instance(overrides: Partial<Provisioning.ChannelInstance>): Provisioning.ChannelInstance {
  return {
    id: "channel:slack:owner",
    provider: "slack",
    identity: "owner",
    enabled: true,
    settings: {},
    credentialRef: "secret:channel-slack-owner",
    revision: 0,
    createdBy: "test",
    updatedAt: 1,
    ...overrides,
  };
}

const OWNER_SESSION = '{"token":"xoxc-1","cookie":"d-cookie"}';
const reader = (plaintext: string): Parameters<typeof declaredChannelProfile>[1] => () => ({
  kind: "ok",
  plaintext: new TextEncoder().encode(plaintext),
});

describe("declared Owner instances", () => {
  test("a slack owner declaration builds through the owner arm as slack:owner, with a delivery route only when outbound is granted", () => {
    const granted = declaredChannelProfile(
      [instance({ grant: { outbound: true } })],
      reader(OWNER_SESSION),
      testChannelDeps(),
    );
    expect(granted.statuses).toEqual([{ id: "channel:slack:owner", provider: "slack", state: "ready" }]);
    expect(granted.rows[0]?.component.identity).toBe("owner");
    const outbound = granted.rows[0]?.component.build(() => Promise.resolve());
    expect(outbound?.surface.id).toBe("slack:owner");
    expect(outbound?.deliveryRoute).toBeDefined();
    expect(outbound?.webhookHandler).toBeUndefined();

    const held = declaredChannelProfile([instance({})], reader(OWNER_SESSION), testChannelDeps());
    const readOnly = held.rows[0]?.component.build(() => Promise.resolve());
    expect(readOnly?.surface.id).toBe("slack:owner");
    // The Owner's account posts only with a declared outbound grant.
    expect(readOnly?.deliveryRoute).toBeUndefined();
  });

  test("the owner arm's credential schema gates the row: the bot's tokens are not an Owner session", () => {
    const { rows, statuses } = declaredChannelProfile(
      [instance({})],
      reader('{"botToken":"xoxb-1","appToken":"xapp-1"}'),
      testChannelDeps(),
    );
    expect(rows).toEqual([]);
    expect(statuses[0]).toMatchObject({ id: "channel:slack:owner", state: "credential_invalid" });
    expect(validateProviderCredential("slack", { token: "xoxc-1", cookie: "d" }, "owner")).toBeUndefined();
    expect(validateProviderCredential("slack", { botToken: "xoxb-1", appToken: "xapp-1" }, "owner")).toBeDefined();
    expect(validateProviderCredential("slack", { botToken: "xoxb-1", appToken: "xapp-1" })).toBeUndefined();
  });

  test("an Owner session that is not JSON is credential_invalid before the arm's schema sees it", () => {
    const { rows, statuses } = declaredChannelProfile([instance({})], reader("xoxc-1 d-cookie"), testChannelDeps());
    expect(rows).toEqual([]);
    expect(statuses[0]).toMatchObject({
      id: "channel:slack:owner",
      state: "credential_invalid",
      detail: expect.stringContaining("credential payload is not JSON"),
    });
  });

  test("a platform without an owner arm reports identity_unsupported and mounts nothing", () => {
    const { rows, statuses } = declaredChannelProfile(
      [instance({ id: "channel:telegram:owner", provider: "telegram", credentialRef: "secret:tg" })],
      reader('{"token":"tg"}'),
      testChannelDeps(),
    );
    expect(rows).toEqual([]);
    expect(statuses).toEqual([
      {
        id: "channel:telegram:owner",
        provider: "telegram",
        state: "identity_unsupported",
        detail: "telegram has no Owner-account arm",
      },
    ]);
    expect(validateProviderCredential("telegram", { token: "tg" }, "owner")).toBe("telegram has no Owner-account arm");
  });
});

describe("the supervisor with an Owner instance", () => {
  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
  const typingRoutes = new Map<string, ProviderTypingRoute>();
  const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
  const calls: string[] = [];

  function component(id: "slack", identity: "bot" | "owner", deliver: boolean): ChannelComponent {
    return {
      id,
      identity,
      build: () => ({
        surface: {
          id: `${id}:${identity}`,
          config: {},
          async start() {
            calls.push(`start:${id}:${identity}`);
          },
          stop() {
            calls.push(`stop:${id}:${identity}`);
          },
          onMessage() {
            // bound at build time
          },
        },
        ...(deliver ? { deliveryRoute: async () => ({ value: "accepted" as const }) } : {}),
      }),
    };
  }

  beforeEach(() => {
    calls.length = 0;
    deliveryRoutes.clear();
    typingRoutes.clear();
    webhookHandlers.clear();
  });
  afterEach(async () => {
    for (const grant of plane().stores.channelGrants.list()) plane().stores.channelGrants.remove(grant.id);
  });

  test("routes key by instance; only the bot instance registers the platform's ingress grant", async () => {
    const desired: DesiredChannels = {
      source: "declared",
      rows: [
        { instanceId: "channel:slack:main", key: "0:0", component: component("slack", "bot", true), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER },
        { instanceId: "channel:slack:owner", key: "0:0", component: component("slack", "owner", true), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER },
      ],
      statuses: [],
    };
    const grants: string[] = [];
    const supervisor = createChannelSupervisor({
      desired: () => desired,
      build: (row) => row.build(async () => undefined),
      grant: (surface, defaultTier) => {
        grants.push(surface);
        return registerTrustedChannelGrant(plane().stores.channelGrants, { surface, defaultTier });
      },
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    const statuses = await supervisor.reconcile();
    expect(statuses.map((status) => [status.id, status.surface, status.state])).toEqual([
      ["channel:slack:main", "slack:bot", "mounted"],
      ["channel:slack:owner", "slack:owner", "mounted"],
    ]);
    expect([...deliveryRoutes.keys()].sort()).toEqual(["slack:bot", "slack:owner"]);
    // One ingress grant, for the platform, from the bot instance alone.
    expect(grants).toEqual(["slack"]);
    expect(resolveChannelGrant(channelStores(),{ surface: "slack" })?.grant.kind).toBe("trusted_channel");
    expect(resolveChannelGrant(channelStores(),{ surface: "slack:owner" })).toBeUndefined();
    await supervisor.stopAll();
    expect(deliveryRoutes.size).toBe(0);
    expect(resolveChannelGrant(channelStores(),{ surface: "slack" })).toBeUndefined();
    expect(calls).toEqual(["start:slack:bot", "start:slack:owner", "stop:slack:owner", "stop:slack:bot"]);
  });
});
