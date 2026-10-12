import { describe, expect, test } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import type { ProviderRuntime } from "../src/provider/contract";
import { ChannelProviders } from "../src/provider/registry";
import type { PublishPort } from "../src/types";

const noopPublish: PublishPort = () => {};
interface ConformanceCase {
  readonly provider: (typeof ChannelProviders)[keyof typeof ChannelProviders];
  readonly credential: Record<string, string>;
  readonly build: (publish: PublishPort) => ProviderRuntime;
  readonly rendered: string;
  readonly limit: number | null;
}
const cases: readonly ConformanceCase[] = [
  {
    provider: ChannelProviders.telegram, rendered: "*hi* `code`", limit: 4096,
    credential: { token: "tg-token" },
    build: (publish) => ChannelProviders.telegram.create({ token: "tg-token" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.discord, rendered: "**hi** `code`", limit: 2000,
    credential: { token: "dc-token" },
    build: (publish) => ChannelProviders.discord.create({ token: "dc-token" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.github, rendered: "**hi** `code`", limit: null,
    credential: { secret: "hook-secret", token: "api", botUsername: "omni-bot" },
    build: (publish) => ChannelProviders.github.create(
      { secret: "hook-secret", token: "api", botUsername: "omni-bot" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.slack, rendered: "**hi** `code`", limit: 4000,
    credential: { botToken: "xoxb-test", appToken: "xapp-test" },
    build: (publish) => ChannelProviders.slack.create(
      { botToken: "xoxb-test", appToken: "xapp-test" }, {}, publish, injectedOptions()),
  },
  {
    provider: ChannelProviders.webhook, rendered: "**hi** `code`", limit: null,
    credential: { id: "hook-1", secretRef: "secret:hook-1" },
    build: (publish) => ChannelProviders.webhook.create(
      { id: "hook-1", secretRef: "secret:hook-1" }, {}, publish, injectedOptions()),
  },
];

describe("provider conformance", () => {
  test("registry keys equal provider ids", () => {
    for (const [key, provider] of Object.entries(ChannelProviders))
      expect(provider.id).toBe(key as keyof typeof ChannelProviders);
  });
  test("every registry entry has a conformance case", () => {
    const covered: string[] = cases.map((kase) => kase.provider.id);
    expect(covered.sort()).toEqual(Object.keys(ChannelProviders).sort());
  });
  for (const kase of cases) {
    describe(kase.provider.id, () => {
      test("runtime seams match declared capabilities", () => {
        const runtime = kase.build(noopPublish);
        expect(runtime.surface.id).toBe(kase.provider.id);
        expect(runtime.deliveryRoute !== undefined).toBe(kase.provider.capabilities.deliver);
        expect(runtime.webhookHandler !== undefined).toBe(kase.provider.capabilities.webhook);
      });
      test("credentials schema admits the conformance credential and refuses junk", () => {
        expect(kase.provider.credentials.safeParse(kase.credential).success).toBe(true);
        expect(kase.provider.credentials.safeParse({ bogus: "x" }).success).toBe(false);
        expect(kase.provider.credentials.safeParse({ ...kase.credential, extra: "x" }).success).toBe(false);
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
      test("preconditions are a verbatim operator checklist", () => {
        for (const precondition of kase.provider.preconditions)
          expect(precondition.length).toBeGreaterThan(0);
      });
      test("construction is pure — nothing published before start", () => {
        let published = 0;
        kase.build(() => { published += 1; });
        expect(published).toBe(0);
      });
    });
  }
});
