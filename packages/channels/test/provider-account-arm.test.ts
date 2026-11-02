import { describe, expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { ChannelProviders } from "../src/provider/registry.js";
import { createSlackProvider } from "../src/provider/slack/provider.js";
import type { PublishPort } from "../src/types.js";
import { injectedOptions } from "./helpers/injected.js";
import { fakeSlackAccountSdk, ACCOUNT_DM } from "./helpers/slack-account-sdk.js";
import { fakeSlackSdk } from "./helpers/slack-sdk.js";

const noopPublish: PublishPort = () => undefined;

/**
 * The Account-identity arm of the provider contract (#1569 lane 5): where a
 * platform has one, it validates the account session, mounts under
 * `<platform>:account`, and exposes exactly the seams its capabilities declare.
 * Every other registry entry has none, which the app reports as
 * `identity_unsupported` rather than mounting anything.
 */
describe("provider account arms", () => {
  test("telegram, slack, discord and the Account-only platforms carry an Account arm, all listening; the rest have none", () => {
    expect(
      Object.entries(ChannelProviders)
        .filter(([, provider]) => provider.account !== undefined)
        .map(([key, provider]) => [key, provider.account?.listen]),
    ).toEqual([
      ["telegram", true],
      ["discord", true],
      ["slack", true],
      ["instagram", true],
      ["kakaotalk", true],
      ["linear", true],
    ]);
  });

  test("an Account-only platform's bot arm refuses every declaration and names the account arm instead", () => {
    for (const key of ["instagram", "kakaotalk", "linear"] as const) {
      const provider = ChannelProviders[key];
      expect(provider.credentials.safeParse({ token: "x" }).success).toBe(false);
      expect(provider.credentials.safeParse({}).success).toBe(false);
      expect(() => provider.create({} as never, {}, noopPublish, injectedOptions())).toThrow(
        `${key} has no bot account; use the account arm`,
      );
      expect(provider.preconditions[0]).toContain("identity: account");
    }
  });

  test("the slack account arm's runtime matches its declared capabilities and mounts as slack:account", () => {
    const arm = ChannelProviders.slack.account;
    if (arm === undefined) throw new Error("slack account arm missing");
    const runtime = arm.create({ token: "xoxc-1", cookie: "d" }, noopPublish, injectedOptions());
    expect(runtime.surface.id).toBe("channel:test:main");
    expect(runtime.deliveryRoute !== undefined).toBe(arm.capabilities.deliver);
    expect(runtime.typingRoute !== undefined).toBe(arm.capabilities.typing);
    expect(runtime.webhookHandler).toBeUndefined();
    expect(arm.preconditions.length).toBeGreaterThan(0);
    // The account session, never the bot's tokens; strict against extras.
    expect(arm.credentials.safeParse({ token: "xoxc-1", cookie: "d" }).success).toBe(true);
    expect(arm.credentials.safeParse({ token: "xoxb-1", cookie: "d" }).success).toBe(false);
    expect(arm.credentials.safeParse({ token: "xoxc-1", cookie: "d", extra: "x" }).success).toBe(false);
  });

  test("the slack account arm's delivery route folds the surface receipt into the kernel's custody vocabulary", async () => {
    const account = fakeSlackAccountSdk();
    const arm = createSlackProvider(fakeSlackSdk().sdk, account.sdk).account;
    if (arm === undefined) throw new Error("slack account arm missing");
    const runtime = arm.create({ token: "xoxc-1", cookie: "d" }, noopPublish, injectedOptions());
    if (runtime.deliveryRoute === undefined) throw new Error("slack account arm mounts no delivery route");
    await runtime.surface.start("boot");
    expect(await runtime.deliveryRoute("T1:U7", Outbound.payload("as the Account"), "k-1")).toEqual({
      value: "accepted",
      externalMessageId: "1700.1",
    });
    expect(account.client.of("sendMessage").map((call) => call.args)).toEqual([[ACCOUNT_DM, "as the Account", null]]);
  });
});
