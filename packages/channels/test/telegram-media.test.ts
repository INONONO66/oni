import { afterEach, describe, expect, test } from "bun:test";
import type { Outbound } from "@openomni/protocol";
import { TelegramProvider } from "../src/provider/telegram/provider";
import { injectedOptions } from "./helpers/injected";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureCalls() {
  const calls: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(String(input), init);
      calls.push(request);
      const result =
        request.url.endsWith("/sendChatAction") || request.url.endsWith("/setMessageReaction")
          ? true
          : { message_id: 17 };
      return Response.json({ ok: true, result });
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
}

const mediaOptions = () => ({
  ...injectedOptions(),
  media: async () => ({ bytes: new Uint8Array([1, 2, 3]), name: "shot.png", mime: "image/png" }),
});

describe("Telegram outbound calls", () => {
  test.each([
    { kind: "image", method: "sendPhoto", field: "photo" },
    { kind: "file", method: "sendDocument", field: "document" },
  ] as const)("uploads $kind using $method and its multipart field", async ({
    kind,
    method,
    field,
  }) => {
    const calls = captureCalls();
    const payload: Outbound.Payload = {
      kind: "message",
      parts: [{ kind, ref: "/shot.png", name: "shot.png", caption: "screenshot" }],
    };
    const runtime = TelegramProvider.create(
      { token: "tg-test" },
      {},
      () => undefined,
      mediaOptions(),
    );
    expect(
      await runtime.deliveryRoute?.("123", payload, `upload-${kind}`, {
        channelId: "456",
        replyToMessageId: "88",
      }),
    ).toEqual({ value: "accepted", externalMessageId: "17" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bottg-test/${method}`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Content-Type")).toStartWith("multipart/form-data; boundary=");
    const form = await calls[0]?.formData();
    expect([...(form?.keys() ?? [])].sort()).toEqual(
      ["caption", "chat_id", field, "reply_to_message_id"].sort(),
    );
    expect(form?.get("chat_id")).toBe("456");
    expect(form?.get("reply_to_message_id")).toBe("88");
    expect(form?.get("caption")).toBe("screenshot");
    const upload = form?.get(field);
    expect(upload).toBeInstanceOf(File);
    expect(upload).toMatchObject({ name: "shot.png", type: "image/png" });
    expect(upload instanceof Blob && [...new Uint8Array(await upload.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
  });

  test("sets the message reaction with Telegram's emoji object", async () => {
    const calls = captureCalls();
    const runtime = TelegramProvider.create(
      { token: "tg-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "123",
        { kind: "react", messageId: "88", emoji: "👍" },
        "react",
        { channelId: "456" },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "88" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottg-test/setMessageReaction");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(await calls[0]?.json()).toEqual({
      chat_id: "456",
      message_id: 88,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  test("sends the typing action into the supplied chat", async () => {
    const calls = captureCalls();
    const runtime = TelegramProvider.create(
      { token: "tg-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    if (runtime.typingRoute === undefined) throw new Error("telegram has no typing route");
    await runtime.typingRoute.pulse(await runtime.typingRoute.open("123", { channelId: "456" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bottg-test/sendChatAction");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(await calls[0]?.json()).toEqual({ chat_id: "456", action: "typing" });
  });
});
