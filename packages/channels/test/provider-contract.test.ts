import { describe, expect, test } from "bun:test";
import { Outbound, type PlainValue } from "@oni/protocol";
import { injectedOptions } from "./helpers/injected";
import type { OwnerArm, ProviderRuntime } from "../src/provider/contract";
import { ChannelProviders } from "../src/provider/registry";
import type { PublishPort } from "../src/types";

/**
 * Provider conformance: every registry entry honors the contract's structural
 * laws. Each case carries a construction closure with that provider's typed
 * credential, so a new provider is covered by adding one case — and the
 * cases-cover-registry test refuses a registration without one. Construction
 * is contractually pure (no I/O until start), which is what lets this run
 * offline.
 */

const noopPublish: PublishPort = () => {
  // Conformance constructs runtimes; nothing should publish before start().
};
interface ConformanceCase {
  readonly provider: (typeof ChannelProviders)[keyof typeof ChannelProviders];
  /** The credential the case constructs with — also the schema's positive fixture. */
  readonly credential: Record<string, string>;
  /** Per-case construction closure — keeps each provider's credential type concrete. */
  readonly build: (publish: PublishPort) => ProviderRuntime;
  readonly rendered: string;
  readonly limit: number | null;
}
/** Surfaces whose deliver posts into a conversation (covered by their surface tests). */
const CONVERSATION_SURFACES = new Set(["discord", "slack", "telegram"]);
/** Providers whose conversation is the only place a letter can land (a task, an issue): the hint is honored by construction. */
// a2a: the conversation is the peer's context; github (#1600 lane R2): the issue the comment lands on.
const CONVERSATION_TARGETS = new Set<string>(["a2a", "github"]);

/**
 * #1569 lane 7: an Owner-only platform has no bot account — its bot arm
 * refuses every credential and never constructs, and the platform is
 * reached through its `owner` arm alone. These cases conform the arm.
 */
interface OwnerOnlyCase {
  readonly provider:
    | (typeof ChannelProviders)["instagram"]
    | (typeof ChannelProviders)["kakaotalk"]
    | (typeof ChannelProviders)["linear"];
  readonly credential: Record<string, string>;
  readonly build: (publish: PublishPort) => ProviderRuntime;
  readonly rendered: string;
  readonly limit: number | null;
  /** The platform reaches the Owner's account over a webhook rather than a socket (#1569 lane 9b, Linear). */
  readonly webhook?: boolean;
}
/** What the conformance reads off an Owner arm, whatever credential type it carries. */
type ArmFacts = Pick<OwnerArm<never>, "listen" | "capabilities" | "preconditions"> & {
  readonly credentials: { safeParse(input: PlainValue): { readonly success: boolean } };
};

/** The arm an Owner-only platform is reached through; its absence would be a registry defect. */
function ownerArmOf(provider: { readonly id: string; readonly owner?: ArmFacts }): ArmFacts {
  if (provider.owner === undefined) throw new Error(`${provider.id} has no owner arm`);
  return provider.owner;
}
const instagramArm = () => {
  const arm = ChannelProviders.instagram.owner;
  if (arm === undefined) throw new Error("instagram has no owner arm");
  return arm;
};
const kakaoArm = () => {
  const arm = ChannelProviders.kakaotalk.owner;
  if (arm === undefined) throw new Error("kakaotalk has no owner arm");
  return arm;
};
const linearArm = () => {
  const arm = ChannelProviders.linear.owner;
  if (arm === undefined) throw new Error("linear has no owner arm");
  return arm;
};
const ownerOnlyCases: readonly OwnerOnlyCase[] = [
  {
    provider: ChannelProviders.instagram,
    rendered: "**hi** `code`",
    limit: 1000,
    credential: { session: JSON.stringify({ cookies: "sessionid=x", device: {}, user_id: "1" }) },
    build: (publish) =>
      instagramArm().create(
        { session: JSON.stringify({ cookies: "sessionid=x", device: {}, user_id: "1" }) },
        { intake: "none", autoReply: false },
        publish,
        injectedOptions(),
      ),
  },
  {
    provider: ChannelProviders.kakaotalk,
    rendered: "**hi** `code`",
    limit: 4000,
    credential: { oauthToken: "oauth", userId: "1001" },
    build: (publish) =>
      kakaoArm().create(
        { oauthToken: "oauth", userId: "1001" },
        { intake: "none", autoReply: false },
        publish,
        injectedOptions(),
      ),
  },
  {
    provider: ChannelProviders.linear,
    rendered: "**hi** `code`",
    limit: null,
    credential: { secret: "hook-secret", token: "lin_api", ownerUserId: "user-owner" },
    webhook: true,
    build: (publish) =>
      linearArm().create(
        { secret: "hook-secret", token: "lin_api", ownerUserId: "user-owner" },
        { intake: "none", autoReply: false },
        publish,
        injectedOptions(),
      ),
  },
];

const cases: readonly ConformanceCase[] = [
  {
    provider: ChannelProviders.telegram,
    rendered: "*hi* `code`",
    limit: 4096,
    credential: { token: "tg-token" },
    build: (publish) =>
      ChannelProviders.telegram.create({ token: "tg-token" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.discord,
    rendered: "**hi** `code`",
    limit: 2000,
    credential: { token: "dc-token" },
    build: (publish) =>
      ChannelProviders.discord.create({ token: "dc-token" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.github,
    rendered: "**hi** `code`",
    limit: null,
    credential: { secret: "hook-secret", token: "api", botUsername: "omni-bot" },
    build: (publish) =>
      ChannelProviders.github.create(
        { secret: "hook-secret", token: "api", botUsername: "omni-bot" },
        {},
        publish,
        injectedOptions(),
      ),
  },
  {
    provider: ChannelProviders.a2a,
    rendered: "**hi** `code`",
    limit: null,
    credential: { token: "peer-token", url: "https://peer.example" },
    build: (publish) =>
      ChannelProviders.a2a.create({ token: "peer-token", url: "https://peer.example" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.slack,
    rendered: "**hi** `code`",
    limit: 4000,
    credential: { botToken: "xoxb-test", appToken: "xapp-test" },
    build: (publish) =>
      ChannelProviders.slack.create(
        { botToken: "xoxb-test", appToken: "xapp-test" },
        {},
        publish,
        injectedOptions(),
      ),
  },
  {
    provider: ChannelProviders.webhook,
    rendered: "**hi** `code`",
    limit: null,
    credential: { id: "hook-1", secretRef: "secret:hook-1" },
    build: (publish) =>
      ChannelProviders.webhook.create(
        { id: "hook-1", secretRef: "secret:hook-1" },
        {},
        publish,
        injectedOptions(),
      ),
  },
];

describe("provider conformance", () => {
  test("registry keys equal provider ids", () => {
    for (const [key, provider] of Object.entries(ChannelProviders))
      expect(provider.id).toBe(key as keyof typeof ChannelProviders);
  });
  test("every registry entry has a conformance case", () => {
    const covered: string[] = [...cases, ...ownerOnlyCases].map((kase) => kase.provider.id);
    expect(covered.sort()).toEqual(Object.keys(ChannelProviders).sort());
  });
  for (const kase of ownerOnlyCases) {
    describe(`${kase.provider.id} (Owner-only)`, () => {
      test("the bot arm refuses every credential and never constructs", () => {
        expect(kase.provider.credentials.safeParse(kase.credential).success).toBe(false);
        expect(kase.provider.credentials.safeParse({}).success).toBe(false);
        expect(() => kase.provider.create({} as never, {}, noopPublish, injectedOptions())).toThrow("identity: owner");
        expect(kase.provider.capabilities.webhook).toBe(kase.webhook ?? false);
        expect(kase.provider.settings.safeParse({ knob: "x" }).success).toBe(false);
      });
      test("the owner arm's seams match its declared capabilities and mount as <platform>:owner", () => {
        const arm = ownerArmOf(kase.provider);
        const runtime = kase.build(noopPublish);
        expect(runtime.surface.id).toBe(`${kase.provider.id}:owner`);
        expect(runtime.deliveryRoute !== undefined).toBe(arm.capabilities.deliver);
        expect(runtime.typingRoute !== undefined).toBe(arm.capabilities.typing);
        expect(runtime.webhookHandler !== undefined).toBe(kase.webhook ?? false);
        expect(arm.listen).toBe(true);
      });
      test("the owner arm's credential schema admits the account session and refuses junk, strictly", () => {
        const arm = ownerArmOf(kase.provider);
        expect(arm.credentials.safeParse(kase.credential).success).toBe(true);
        expect(arm.credentials.safeParse({ bogus: "x" }).success).toBe(false);
        expect(arm.credentials.safeParse({ ...kase.credential, extra: "x" }).success).toBe(false);
      });
      test("render policy is the platform's plain text and its delivery limit", () => {
        const policy = kase.provider.capabilities.render;
        expect(policy.renderMarkdown("**hi** `code`")).toBe(kase.rendered);
        expect(policy.messageLimit).toBe(kase.limit);
        expect(kase.provider.capabilities.media).toBe(false);
      });
      test("preconditions are a verbatim operator checklist naming the owner arm", () => {
        for (const precondition of [...kase.provider.preconditions, ...ownerArmOf(kase.provider).preconditions])
          expect(precondition.length).toBeGreaterThan(0);
        expect(kase.provider.preconditions.some((text) => text.includes("identity: owner"))).toBe(true);
      });
      test("construction is pure — nothing published before start", () => {
        let published = 0;
        kase.build(() => {
          published += 1;
        });
        expect(published).toBe(0);
      });
    });
  }
  for (const kase of cases) {
    describe(kase.provider.id, () => {
      test("runtime seams match declared capabilities", () => {
        const runtime = kase.build(noopPublish);
        expect(runtime.surface.id).toBe(
          CONVERSATION_SURFACES.has(kase.provider.id) ? `${kase.provider.id}:bot` : kase.provider.id,
        );
        expect(runtime.deliveryRoute !== undefined).toBe(kase.provider.capabilities.deliver);
        expect(runtime.webhookHandler !== undefined).toBe(kase.provider.capabilities.webhook);
        expect(runtime.typingRoute !== undefined).toBe(kase.provider.capabilities.typing);
      });
      test("a conversation hint is honored or refused, never silently delivered as a DM (#1490)", async () => {
        const runtime = kase.build(noopPublish);
        if (
          runtime.deliveryRoute === undefined ||
          CONVERSATION_SURFACES.has(kase.provider.id) ||
          CONVERSATION_TARGETS.has(kase.provider.id)
        )
          return;
        await expect(
          runtime.deliveryRoute("ext-1", Outbound.payload("hi"), "key-1", { channelId: "chan-1" }),
        ).rejects.toMatchObject({
          _tag: "DeliveryNotSent",
          operation: `${kase.provider.id}.deliver`,
        });
      });
      test("credentials schema admits the conformance credential and refuses junk", () => {
        expect(kase.provider.credentials.safeParse(kase.credential).success).toBe(true);
        expect(kase.provider.credentials.safeParse({ bogus: "x" }).success).toBe(false);
        // strict: an extra key on a valid payload is refused, never silently dropped
        expect(
          kase.provider.credentials.safeParse({ ...kase.credential, extra: "x" }).success,
        ).toBe(false);
      });
      test("settings schema admits only the empty record", () => {
        expect(kase.provider.settings.safeParse({}).success).toBe(true);
        expect(kase.provider.settings.safeParse({ knob: "x" }).success).toBe(false);
      });
      test("render policy uses the platform dialect and delivery limit", () => {
        const policy = kase.provider.capabilities.render;
        expect(policy.renderMarkdown("**hi** `code`")).toBe(kase.rendered);
        expect(policy.messageLimit).toBe(kase.limit);
      });
      test("media capability declares positive upload and caption limits or is disabled", () => {
        const media = kase.provider.capabilities.media;
        if (media === false) {
          expect(media).toBe(false);
          return;
        }
        expect(media.imageBytes).toBeGreaterThan(0);
        expect(media.fileBytes).toBeGreaterThan(0);
        expect(media.captionLength).toBeGreaterThan(0);
      });
      test("preconditions are a verbatim operator checklist", () => {
        for (const precondition of kase.provider.preconditions)
          expect(precondition.length).toBeGreaterThan(0);
      });
      test("construction is pure — nothing published before start", () => {
        let published = 0;
        kase.build(() => {
          published += 1;
        });
        expect(published).toBe(0);
      });
    });
  }
});
