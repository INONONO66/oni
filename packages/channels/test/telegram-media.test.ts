import { describe, expect, test } from "bun:test";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import { injectedOptions } from "./helpers/injected";
import { fakeTelegramSdk } from "./helpers/telegram-sdk";

describe("Telegram outbound SDK calls", () => {
  test.each(["image", "file"] as const)("uploads %s media with caption", async (kind) => {
    const fake = fakeTelegramSdk();
    const runtime = createTelegramProvider(fake.sdk).create(
      { token: "tg-test" },
      {},
      () => undefined,
      { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array([1, 2, 3]), name: "shot.png", mime: "image/png" }) },
    );
    expect(await runtime.deliveryRoute?.("123", {
      kind: "message",
      parts: [{ kind, ref: "/shot.png", name: "shot.png", caption: "screenshot" }],
    }, `upload-${kind}`, { channelId: "456", replyToMessageId: "88" })).toEqual({
      value: "accepted",
      externalMessageId: "17",
    });
    expect(fake.client.calls[0]?.method).toBe(kind === "image" ? "sendPhoto" : "sendDocument");
    expect(fake.client.calls[0]?.options).toMatchObject({ caption: "screenshot" });
  });

  test("sets a message reaction through the SDK client", async () => {
    const fake = fakeTelegramSdk();
    const runtime = createTelegramProvider(fake.sdk).create({ token: "tg-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("123", { kind: "react", messageId: "88", emoji: "👍" }, "react", { channelId: "456" })).toEqual({
      value: "accepted",
      externalMessageId: "88",
    });
    expect(fake.client.calls[0]?.method).toBe("setMessageReaction");
  });

  test("downloads an inbound file by its file_id and names it from the file path", async () => {
    const fake = fakeTelegramSdk();
    const runtime = createTelegramProvider(fake.sdk).create({ token: "tg-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.attachments?.("AgAC-1")).toEqual({
      bytes: new TextEncoder().encode("AgAC-1"),
      name: "AgAC-1.bin",
      mime: "application/octet-stream",
    });
    expect(fake.client.calls[0]?.method).toBe("downloadFile");
  });
});
