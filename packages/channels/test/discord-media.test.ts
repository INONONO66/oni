import { describe, expect, test } from "bun:test";
import { createDiscordProvider } from "../src/provider/discord/provider";
import { injectedOptions } from "./helpers/injected";
import { fakeDiscordSdk } from "./helpers/discord-sdk";

describe("Discord outbound SDK calls", () => {
  test("uploads media with caption and reply reference", async () => {
    const fake = fakeDiscordSdk();
    const runtime = createDiscordProvider(fake.sdk).create(
      { token: "dc-test" },
      {},
      () => undefined,
      { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array([4, 5]), name: "shot.png", mime: "image/png" }) },
    );
    expect(await runtime.deliveryRoute?.("U1", {
      kind: "message",
      parts: [{ kind: "image", ref: "/shot.png", name: "shot.png", caption: "image caption" }],
    }, "media-1", { channelId: "C1", replyToMessageId: "m-9" })).toEqual({
      value: "accepted",
      externalMessageId: "m-17",
    });
    expect(fake.client.calls).toContainEqual({ method: "createMessage", channelId: "C1" });
  });

  test("settles a replacing reaction when the old reaction is already gone", async () => {
    const fake = fakeDiscordSdk();
    const runtime = createDiscordProvider(fake.sdk).create({ token: "dc-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("U1", { kind: "react", messageId: "m-9", emoji: "✅", replaces: "👀" }, "react-1", { channelId: "C1" })).toEqual({
      value: "accepted",
      externalMessageId: "m-9",
    });
    expect(fake.client.calls.map(({ method }) => method)).toEqual(["removeReaction", "addReaction"]);
  });
});
