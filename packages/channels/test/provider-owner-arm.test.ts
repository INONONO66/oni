import { describe, expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { ChannelProviders } from "../src/provider/registry";
import { createSlackProvider } from "../src/provider/slack/provider";
import type { PublishPort } from "../src/types";
import { injectedOptions } from "./helpers/injected";
import { fakeSlackOwnerSdk, OWNER_DM } from "./helpers/slack-owner-sdk";
import { fakeSlackSdk } from "./helpers/slack-sdk";

const noopPublish: PublishPort = () => undefined;

/**
 * The Owner-identity arm of the provider contract (#1569 lane 5): where a
 * platform has one, it validates the account session, mounts under
 * `<platform>:owner`, and exposes exactly the seams its capabilities declare.
 * Every other registry entry has none, which the app reports as
 * `identity_unsupported` rather than mounting anything.
 */
describe("provider owner arms", () => {
  test("only slack carries an Owner arm today", () => {
    expect(
      Object.entries(ChannelProviders)
        .filter(([, provider]) => provider.owner !== undefined)
        .map(([key]) => key),
    ).toEqual(["slack"]);
  });

  test("the slack owner arm's runtime matches its declared capabilities and mounts as slack:owner", () => {
    const arm = ChannelProviders.slack.owner;
    if (arm === undefined) throw new Error("slack owner arm missing");
    const runtime = arm.create({ token: "xoxc-1", cookie: "d" }, {}, noopPublish, injectedOptions());
    expect(runtime.surface.id).toBe("slack:owner");
    expect(runtime.deliveryRoute !== undefined).toBe(arm.capabilities.deliver);
    expect(runtime.typingRoute !== undefined).toBe(arm.capabilities.typing);
    expect(runtime.webhookHandler).toBeUndefined();
    expect(arm.preconditions.length).toBeGreaterThan(0);
    // The account session, never the bot's tokens; strict against extras.
    expect(arm.credentials.safeParse({ token: "xoxc-1", cookie: "d" }).success).toBe(true);
    expect(arm.credentials.safeParse({ token: "xoxb-1", cookie: "d" }).success).toBe(false);
    expect(arm.credentials.safeParse({ token: "xoxc-1", cookie: "d", extra: "x" }).success).toBe(false);
  });

  test("the slack owner arm's delivery route folds the surface receipt into the kernel's custody vocabulary", async () => {
    const owner = fakeSlackOwnerSdk();
    const arm = createSlackProvider(fakeSlackSdk().sdk, owner.sdk).owner;
    if (arm === undefined) throw new Error("slack owner arm missing");
    const runtime = arm.create({ token: "xoxc-1", cookie: "d" }, {}, noopPublish, injectedOptions());
    if (runtime.deliveryRoute === undefined) throw new Error("slack owner arm mounts no delivery route");
    await runtime.surface.start("boot");
    expect(await runtime.deliveryRoute("T1:U7", Outbound.payload("as the Owner"), "k-1")).toEqual({
      value: "accepted",
      externalMessageId: "1700.1",
    });
    expect(owner.client.of("sendMessage").map((call) => call.args)).toEqual([[OWNER_DM, "as the Owner", null]]);
  });
});
