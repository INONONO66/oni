import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type ChannelDeliveryRoute, type ProviderTypingRoute, resolveChannelGrant } from "@oni/channels";
import type { Provisioning } from "@oni/protocol";
import { createMountedChannelGrantRegistrar, MOUNTED_CHANNEL_DEFAULT_TIER, registerTrustedChannelGrant } from "../src/gateway";
import { bindOwnerAccount, ownerAccountBinder } from "../src/bundles/provision/declared";
import {
  type ChannelComponent,
  declaredChannelProfile,
  validateProviderCredential,
  validateProviderSettings,
} from "../src/channels";
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

  test("an Owner declaration's settings are its intake posture: the default reads mentions and DMs, `none` only sends, a bot knob is refused", () => {
    const reading = declaredChannelProfile([instance({})], reader(OWNER_SESSION), testChannelDeps());
    expect(reading.rows[0]?.component).toMatchObject({ identity: "owner", listens: true });
    const sendOnly = declaredChannelProfile([instance({ settings: { intake: "none" } })], reader(OWNER_SESSION), testChannelDeps());
    expect(sendOnly.rows[0]?.component).toMatchObject({ identity: "owner", listens: false });
    const bad = declaredChannelProfile([instance({ settings: { intake: "loud" } })], reader(OWNER_SESSION), testChannelDeps());
    expect(bad.rows).toEqual([]);
    expect(bad.statuses[0]).toMatchObject({ state: "credential_invalid", detail: expect.stringContaining("settings:") });
    expect(validateProviderSettings("slack", { intake: "all" }, "owner")).toBeUndefined();
    expect(validateProviderSettings("slack", { intake: "all" })).toBeDefined();
    expect(validateProviderSettings("slack", { botUsername: "x" }, "owner")).toBeDefined();
  });

  test("an Owner-only platform mounts through its owner arm; a bot declaration of it is identity_unsupported (#1569 lane 7)", () => {
    const session = JSON.stringify({ cookies: "sessionid=x", device: {}, user_id: "1" });
    const owner = declaredChannelProfile(
      [instance({ id: "channel:instagram:owner", provider: "instagram", credentialRef: "secret:ig", settings: { autoReply: true }, grant: { outbound: true } })],
      reader(JSON.stringify({ session })),
      testChannelDeps(),
    );
    expect(owner.rows[0]?.component).toMatchObject({ id: "instagram", identity: "owner", listens: true });
    expect(owner.rows[0]?.component.build(async () => undefined)).toMatchObject({ autoReply: true });
    // Without an outbound grant the auto-reply means nothing: no route, no auto-reply.
    const drafting = declaredChannelProfile(
      [instance({ id: "channel:instagram:owner", provider: "instagram", credentialRef: "secret:ig", settings: { autoReply: true } })],
      reader(JSON.stringify({ session })),
      testChannelDeps(),
    );
    expect(drafting.rows[0]?.component.build(async () => undefined).autoReply).toBeUndefined();
    const bot = declaredChannelProfile(
      [instance({ id: "channel:kakaotalk:main", provider: "kakaotalk", identity: "bot", credentialRef: "secret:kk" })],
      reader('{"oauthToken":"o","userId":"1"}'),
      testChannelDeps(),
    );
    expect(bot.rows).toEqual([]);
    expect(bot.statuses[0]).toMatchObject({
      state: "identity_unsupported",
      detail: "kakaotalk has no bot account; declare the instance with identity: owner",
    });
    expect(validateProviderCredential("instagram", { token: "x" })).toContain("identity: owner");
    expect(validateProviderCredential("kakaotalk", { oauthToken: "o", userId: "1" }, "owner")).toBeUndefined();
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

  function component(
    id: "slack",
    identity: "bot" | "owner",
    deliver: boolean,
    listens = identity === "bot",
    account?: { readonly externalId: string; readonly workspace?: string },
  ): ChannelComponent {
    return {
      id,
      identity,
      listens,
      build: () => ({
        ...(account === undefined ? {} : { account: () => account }),
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
    // One ingress grant, for the platform, from the bot instance alone: this Owner row does not read.
    expect(grants).toEqual(["slack"]);
    expect(resolveChannelGrant(channelStores(),{ surface: "slack" })?.grant.kind).toBe("trusted_channel");
    expect(resolveChannelGrant(channelStores(),{ surface: "slack:owner" })).toBeUndefined();
    await supervisor.stopAll();
    expect(deliveryRoutes.size).toBe(0);
    expect(resolveChannelGrant(channelStores(),{ surface: "slack" })).toBeUndefined();
    expect(calls).toEqual(["start:slack:bot", "start:slack:owner", "stop:slack:owner", "stop:slack:bot"]);
  });

  test("the platform's ingress grant is held by every reading instance and revoked with the last (#1569 lane 6)", async () => {
    const bot = { instanceId: "channel:slack:main", key: "0:0", component: component("slack", "bot", true), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER };
    const owner = { instanceId: "channel:slack:owner", key: "0:0", component: component("slack", "owner", true, true), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER };
    let rows = [bot, owner];
    const grants: string[] = [];
    const supervisor = createChannelSupervisor({
      desired: () => ({ source: "declared", rows, statuses: [] }),
      build: (row) => row.build(async () => undefined),
      grant: (surface, defaultTier, ownerIntake) => {
        grants.push(`grant:${surface}`);
        const revoke = registerTrustedChannelGrant(plane().stores.channelGrants, {
          surface,
          defaultTier,
          ...(ownerIntake === true ? { ownerIntake } : {}),
        });
        return () => {
          grants.push(`revoke:${surface}`);
          revoke();
        };
      },
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    await supervisor.reconcile();
    // Both read: the one row is re-registered once the Owner reader joins it (it now names the Owner reader).
    expect(grants).toEqual(["grant:slack", "revoke:slack", "grant:slack"]);
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })?.grant).toMatchObject({ kind: "trusted_channel", ownerIntake: true });
    // The bot leaves; the Owner instance still reads at the same tier, so the row stays as it is.
    rows = [owner];
    await supervisor.reconcile();
    expect(grants).toEqual(["grant:slack", "revoke:slack", "grant:slack"]);
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })?.grant.kind).toBe("trusted_channel");
    // The last reader leaves; the grant goes with it.
    rows = [];
    await supervisor.reconcile();
    expect(grants).toEqual(["grant:slack", "revoke:slack", "grant:slack", "revoke:slack"]);
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })).toBeUndefined();
  });

  test("the one grant row follows its readers: the least declared tier wins and a bounced reader's new tier lands while the other reader holds it", async () => {
    const bot = (tier: "manager" | "observer", key: string) => ({
      instanceId: "channel:slack:main", key, component: component("slack", "bot", true), defaultTier: tier,
    });
    const owner = { instanceId: "channel:slack:owner", key: "0:0", component: component("slack", "owner", true, true), defaultTier: "collaborator" as const };
    let rows = [bot("manager", "0:0"), owner];
    const registered: string[] = [];
    const supervisor = createChannelSupervisor({
      desired: () => ({ source: "declared", rows, statuses: [] }),
      build: (row) => row.build(async () => undefined),
      grant: (surface, defaultTier, ownerIntake) => {
        registered.push(`${surface}:${defaultTier}:${ownerIntake === true}`);
        return registerTrustedChannelGrant(plane().stores.channelGrants, { surface, defaultTier, ...(ownerIntake === true ? { ownerIntake } : {}) });
      },
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    await supervisor.reconcile();
    // The bot mounted first at manager; the Owner reader joined at collaborator: the row is the lesser tier and names the Owner reader.
    expect(registered).toEqual(["slack:manager:false", "slack:collaborator:true"]);
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })?.grant).toMatchObject({ defaultTier: "collaborator", ownerIntake: true });
    // The bot row's tier changes to observer: its bounce lands the new least tier on the row.
    rows = [bot("observer", "1:0"), owner];
    await supervisor.reconcile();
    expect(registered.at(-1)).toBe("slack:observer:true");
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })?.grant).toMatchObject({ defaultTier: "observer", ownerIntake: true });
    // The Owner reader leaves: the row no longer names it and keeps the bot's tier.
    rows = [bot("observer", "1:0")];
    await supervisor.reconcile();
    expect(registered.at(-1)).toBe("slack:observer:false");
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })?.grant.ownerIntake).toBeUndefined();
    await supervisor.stopAll();
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })).toBeUndefined();
  });

  test("the supervisor keeps the auto-replying Owner instances with the routes, from mount to unwind (#1569 lane 7)", async () => {
    const answering: ChannelComponent = {
      id: "slack",
      identity: "owner",
      listens: false,
      build: () => ({
        surface: {
          id: "slack:owner",
          config: {},
          start: () => Promise.resolve(),
          stop: () => undefined,
          onMessage: () => undefined,
        },
        deliveryRoute: async () => ({ value: "accepted" as const }),
        autoReply: true,
      }),
    };
    let rows = [{ instanceId: "channel:slack:owner", key: "0:0", component: answering, defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER }];
    const autoReplies = new Set<string>();
    const supervisor = createChannelSupervisor({
      desired: () => ({ source: "declared", rows, statuses: [] }),
      build: (row) => row.build(async () => undefined),
      grant: (surface, defaultTier) => registerTrustedChannelGrant(plane().stores.channelGrants, { surface, defaultTier }),
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      autoReplies,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    await supervisor.reconcile();
    expect([...autoReplies]).toEqual(["slack:owner"]);
    rows = [];
    await supervisor.reconcile();
    expect(autoReplies.size).toBe(0);
  });

  test("an Owner instance that reads alone registers the platform's grant itself", async () => {
    const grants: string[] = [];
    const supervisor = createChannelSupervisor({
      desired: () => ({
        source: "declared",
        rows: [{ instanceId: "channel:slack:owner", key: "0:0", component: component("slack", "owner", false, true), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER }],
        statuses: [],
      }),
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
    await supervisor.reconcile();
    expect(grants).toEqual(["slack"]);
    expect(deliveryRoutes.size).toBe(0);
    await supervisor.stopAll();
    expect(resolveChannelGrant(channelStores(), { surface: "slack" })).toBeUndefined();
  });
});

describe("#1600: the declaration's grant policy and the Owner account", () => {
  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
  const typingRoutes = new Map<string, ProviderTypingRoute>();
  const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
  afterEach(async () => {
    for (const grant of plane().stores.channelGrants.list()) plane().stores.channelGrants.remove(grant.id);
  });
  const component = (identity: "bot" | "owner", account?: { readonly externalId: string; readonly workspace?: string }): ChannelComponent => ({
    id: "slack",
    identity,
    listens: true,
    build: () => ({
      surface: { id: `slack:${identity}`, config: {}, async start() { /* nothing to open */ }, stop() { /* nothing to close */ }, onMessage() { /* bound at build time */ } },
      ...(account === undefined ? {} : { account: () => account }),
    }),
  });

  test("the bot instance's declared allowlist and posture are the platform grant's; an Owner instance's speak only where the platform has no bot reader; the env lists stand only where no declaration speaks", async () => {
    const rows: DesiredChannels["rows"] = [
      { instanceId: "channel:slack:main", key: "0:0", component: component("bot"), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER, allowedSenders: ["T1:U1"], mentionOnly: true },
      { instanceId: "channel:slack:owner", key: "0:0", component: component("owner"), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER, allowedSenders: ["T1:U2"] },
    ];
    const supervisor = createChannelSupervisor({
      desired: () => ({ source: "declared", rows, statuses: [] }),
      build: (row) => row.build(async () => undefined),
      grant: createMountedChannelGrantRegistrar(plane().stores.channelGrants, { slack: ["T1:env"], telegram: ["env-only"] }, ["telegram"]),
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    await supervisor.reconcile();
    expect(resolveChannelGrant(channelStores(), { surface: "slack", sender: "T1:U1" })?.grant).toMatchObject({ allowedSenders: ["T1:U1"], mentionOnly: true, ownerIntake: true });
    expect(resolveChannelGrant(channelStores(), { surface: "slack", sender: "T1:U2" })).toBeUndefined();
    expect(resolveChannelGrant(channelStores(), { surface: "slack", sender: "T1:env" })).toBeUndefined();
    await supervisor.stopAll();
    // An Owner-only platform: the Owner reader's block is the platform's.
    const ownerOnly = createChannelSupervisor({
      desired: () => ({
        source: "declared",
        rows: [{ instanceId: "channel:slack:owner", key: "0:0", component: component("owner"), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER, allowedSenders: ["T1:U2"], mentionOnly: false }],
        statuses: [],
      }),
      build: (row) => row.build(async () => undefined),
      grant: createMountedChannelGrantRegistrar(plane().stores.channelGrants, undefined, ["slack"]),
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    await ownerOnly.reconcile();
    const ownerGrant = resolveChannelGrant(channelStores(), { surface: "slack", sender: "T1:U2" })?.grant;
    expect(ownerGrant).toMatchObject({ allowedSenders: ["T1:U2"] });
    // An explicit mentionOnly: false in the declaration is not overridden by the env list.
    expect(ownerGrant?.mentionOnly).toBeUndefined();
    await ownerOnly.stopAll();
  });

  test("a binding that throws unwinds the started Owner surface like a failed start", async () => {
    const stops: string[] = [];
    const failing: ChannelComponent = {
      id: "slack",
      identity: "owner",
      listens: true,
      build: () => ({
        surface: { id: "slack:owner", config: {}, async start() { /* opened */ }, stop() { stops.push("slack:owner"); }, onMessage() { /* bound at build time */ } },
        account: () => ({ externalId: "T1:U-owner", workspace: "T1" }),
      }),
    };
    const supervisor = createChannelSupervisor({
      desired: () => ({ source: "declared", rows: [{ instanceId: "channel:slack:owner", key: "0:0", component: failing, defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER }], statuses: [] }),
      build: (row) => row.build(async () => undefined),
      grant: () => () => undefined,
      bindAccount: () => {
        throw new Error("the address is held");
      },
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    const statuses = await supervisor.reconcile();
    expect(statuses.map((status) => [status.id, status.state, status.detail])).toEqual([["channel:slack:owner", "start_failed", "the address is held"]]);
    expect(stops).toEqual(["slack:owner"]);
    expect(deliveryRoutes.has("slack:owner")).toBe(false);
    await supervisor.stopAll();
  });

  test("a started Owner instance's account becomes the Owner Person's endpoint, once; without an owner Person one is created, reachable", async () => {
    const bound: [string, { readonly externalId: string; readonly workspace?: string }][] = [];
    const supervisor = createChannelSupervisor({
      desired: () => ({
        source: "declared",
        rows: [{ instanceId: "channel:slack:owner", key: "0:0", component: component("owner", { externalId: "T1:U-owner", workspace: "T1" }), defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER }],
        statuses: [],
      }),
      build: (row) => row.build(async () => undefined),
      grant: () => () => undefined,
      bindAccount: (platform, account) => {
        bound.push([platform, account]);
      },
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    await supervisor.reconcile();
    expect(bound).toEqual([["slack", { externalId: "T1:U-owner", workspace: "T1" }]]);
    await supervisor.stopAll();
    // The app's binding: no owner Person -> person:owner with the endpoint, reach: true; again -> untouched; an existing owner Person gains the endpoint.
    const persons = plane().stores.persons;
    for (const person of persons.list()) persons.remove(person.id);
    expect(bindOwnerAccount({ persons }, "slack", { externalId: "T1:U-owner", workspace: "T1" }, 5)).toMatchObject({
      bound: {
        id: "person:owner",
        trustTier: "owner",
        reach: true,
        endpoints: [{ channel: "slack", externalId: "T1:U-owner", workspace: "T1" }],
        revision: 0,
      },
    });
    expect(bindOwnerAccount({ persons }, "slack", { externalId: "T1:U-owner", workspace: "T1" }, 6)).toBeUndefined();
    expect(bindOwnerAccount({ persons }, "discord", { externalId: "D-owner" }, 7)).toMatchObject({ bound: { id: "person:owner", revision: 1 } });
    expect(persons.get("person:owner")?.endpoints).toEqual([
      { channel: "slack", externalId: "T1:U-owner", workspace: "T1" },
      { channel: "discord", externalId: "D-owner" },
    ]);
    // An address another Person holds is never re-homed by a mount: named, left to the Owner.
    persons.put({ id: "person:zed", displayName: "Zed", kind: "human", trustTier: "collaborator", endpoints: [{ channel: "telegram", externalId: "9" }], revision: 0, createdBy: "owner", updatedAt: 1 });
    expect(bindOwnerAccount({ persons }, "telegram", { externalId: "9" }, 8)).toEqual({ held: "person:zed" });
    expect(persons.get("person:owner")?.endpoints).toHaveLength(2);
    for (const person of persons.list()) persons.remove(person.id);
    persons.put({ id: "person:ino", displayName: "Ino", kind: "human", trustTier: "owner", endpoints: [{ channel: "telegram", externalId: "1" }], revision: 0, createdBy: "owner", updatedAt: 1 });
    expect(bindOwnerAccount({ persons }, "slack", { externalId: "T1:U-owner", workspace: "T1" }, 8)).toMatchObject({ bound: { id: "person:ino", revision: 1 } });
    expect(persons.get("person:owner")).toBeUndefined();
    for (const person of persons.list()) persons.remove(person.id);
    // The supervisor's binder over it: a binding rebuilds the actors; a held address and a thrown binding are the Owner's to hear, never a failure.
    const warned: [string, Readonly<Record<string, string>>][] = [];
    let rebuilt = 0;
    const binder = ownerAccountBinder({ persons, now: () => 9, rebuildActors: () => { rebuilt += 1; }, warn: (msg, context) => { warned.push([msg, context]); } });
    binder("slack", { externalId: "T1:U-owner", workspace: "T1" });
    expect(rebuilt).toBe(1);
    expect(persons.get("person:owner")?.endpoints).toEqual([{ channel: "slack", externalId: "T1:U-owner", workspace: "T1" }]);
    binder("slack", { externalId: "T1:U-owner", workspace: "T1" });
    expect(rebuilt).toBe(1);
    persons.put({ id: "person:zed", displayName: "Zed", kind: "human", trustTier: "observer", endpoints: [{ channel: "telegram", externalId: "9" }], revision: 0, createdBy: "owner", updatedAt: 1 });
    binder("telegram", { externalId: "9" });
    expect(warned).toEqual([["owner account address held by another person", { platform: "telegram", externalId: "9", holder: "person:zed" }]]);
    expect(rebuilt).toBe(1);
    const closed = spyOn(persons, "put").mockImplementation(() => { throw new Error("store closed"); });
    try {
      binder("discord", { externalId: "D-owner" });
    } finally {
      closed.mockRestore();
    }
    expect(warned[1]).toEqual(["owner account binding failed", { platform: "discord", externalId: "D-owner", detail: "store closed" }]);
    expect(rebuilt).toBe(1);
    for (const person of persons.list()) persons.remove(person.id);
  });
});
