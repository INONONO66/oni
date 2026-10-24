import { describe, expect, test } from "bun:test";
import { createTelegramProvider } from "../src/provider/telegram/provider";
import { telegramSdk } from "../src/provider/telegram/sdk";
import { TelegramApiError } from "../src/errors";
import { injectedOptions } from "./helpers/injected";
import { recordHttp } from "./helpers/http";

describe("Telegram outbound SDK requests", () => {
  test.each(["image", "file"] as const)("uploads %s bytes, caption, topic, and reply", async (kind) => {
    const wire = recordHttp(() => Response.json({ ok: true, result: { message_id: 17 } }));
    try {
      const runtime = createTelegramProvider().create(
        { token: "tg-test" }, {}, () => undefined,
        { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array([1, 2, 3]), name: "shot.png", mime: "image/png" }) },
      );
      expect(await runtime.deliveryRoute?.("123", {
        kind: "message",
        parts: [{ kind, ref: "/shot.png", name: "shot.png", caption: "screenshot" }],
      }, `upload-${kind}`, { channelId: "456", threadId: "3", replyToMessageId: "88" })).toEqual({
        value: "accepted", externalMessageId: "17",
      });
      expect(wire.requests).toHaveLength(1);
      const request = wire.requests[0];
      if (!request) throw new Error("Missing request");
      expect(request.url).toEndWith(kind === "image" ? "/sendPhoto" : "/sendDocument");
      const form = await request.formData();
      expect(form.get("chat_id")).toBe("456");
      expect(form.get("message_thread_id")).toBe("3");
      expect(form.get("reply_to_message_id")).toBe("88");
      expect(form.get("caption")).toBe("screenshot");
      const file = form.get(kind === "image" ? "photo" : "document");
      if (!(file instanceof File)) throw new Error("Missing file");
      expect(file.name).toBe("shot.png");
      expect(file.type).toBe("image/png");
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    } finally { wire.restore(); }
  });

  test.each([
    { part: { kind: "audio", ref: "/note.ogg", voice: true, durationMs: 12_400 }, method: "sendVoice", field: "voice", duration: "12" },
    { part: { kind: "audio", ref: "/song.mp3", name: "song.mp3" }, method: "sendAudio", field: "audio", duration: null },
    { part: { kind: "video", ref: "/clip.mp4", name: "clip.mp4", durationMs: 65_000 }, method: "sendVideo", field: "video", duration: "65" },
  ] as const)("uploads $part.kind through $method with its duration in seconds", async ({ part, method, field, duration }) => {
    const wire = recordHttp(() => Response.json({ ok: true, result: { message_id: 21 } }));
    try {
      const runtime = createTelegramProvider().create(
        { token: "tg-test" }, {}, () => undefined,
        { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array([9, 8]), name: "media.bin", mime: "application/octet-stream" }) },
      );
      expect(await runtime.deliveryRoute?.("123", { kind: "message", parts: [{ ...part, caption: "listen" }] },
        `upload-${method}`, { channelId: "456", threadId: "3", replyToMessageId: "88" })).toEqual({
        value: "accepted", externalMessageId: "21",
      });
      const request = wire.requests[0];
      if (!request) throw new Error("Missing request");
      expect(request.url).toEndWith(`/${method}`);
      const form = await request.formData();
      expect(form.get("duration")).toBe(duration);
      expect(form.get("caption")).toBe("listen");
      expect(form.get("message_thread_id")).toBe("3");
      expect(form.get("reply_to_message_id")).toBe("88");
      const file = form.get(field);
      if (!(file instanceof File)) throw new Error("Missing file");
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([9, 8]);
    } finally { wire.restore(); }
  });

  test("sets the complete reaction list on the addressed message", async () => {
    const wire = recordHttp(() => Response.json({ ok: true, result: true }));
    try {
      const runtime = createTelegramProvider().create({ token: "tg-test" }, {}, () => undefined, injectedOptions());
      expect(await runtime.deliveryRoute?.("123", {
        kind: "react", messageId: "88", emoji: "👍",
      }, "react", { channelId: "456" })).toEqual({ value: "accepted", externalMessageId: "88" });
      expect(wire.requests).toHaveLength(1);
      expect(await wire.requests[0]?.json()).toEqual({
        chat_id: "456", message_id: 88, reaction: [{ type: "emoji", emoji: "👍" }],
      });
    } finally { wire.restore(); }
  });

  test.each([false, 1, "true", null])("rejects malformed mutation acknowledgement %j", async (result) => {
    const wire = recordHttp(() => Response.json({ ok: true, result }));
    try {
      const client = telegramSdk().client();
      await client.login({ token: "token" });
      await expect(client.sendChatAction("1", "typing")).rejects.toBeInstanceOf(TelegramApiError);
      await expect(client.answerCallbackQuery("callback")).rejects.toBeInstanceOf(TelegramApiError);
      const runtime = createTelegramProvider().create({ token: "token" }, {}, () => undefined, injectedOptions());
      const send = () => runtime.deliveryRoute?.("1", { kind: "react", messageId: "2", emoji: "👍" }, "bad-ack");
      expect(await send()).toEqual({ value: "unknown" });
      expect(await send()).toEqual({ value: "unknown" });
      expect(wire.requests).toHaveLength(3);
    } finally { wire.restore(); }
  });
});
