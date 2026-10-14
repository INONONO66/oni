import { afterEach, describe, expect, test } from "bun:test";
import type { Outbound } from "@openomni/protocol";
import { DiscordProvider } from "../src/provider/discord/provider";
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
      return request.method === "POST" && request.url.endsWith("/messages")
        ? Response.json({ id: "m-17" })
        : new Response(null, { status: 204 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
}

describe("Discord outbound calls", () => {
  test("uploads an image with payload_json and files[0] in the reply channel", async () => {
    const calls = captureCalls();
    const runtime = DiscordProvider.create({ token: "dc-test" }, {}, () => undefined, {
      ...injectedOptions(),
      media: async () => ({ bytes: new Uint8Array([4, 5]), name: "shot.png", mime: "image/png" }),
    });
    const payload: Outbound.Payload = {
      kind: "message",
      parts: [{ kind: "image", ref: "/shot.png", name: "shot.png", caption: "image caption" }],
    };
    expect(
      await runtime.deliveryRoute?.("U1", payload, "media-1", {
        channelId: "C1",
        replyToMessageId: "m-9",
      }),
    ).toEqual({ value: "accepted", externalMessageId: "m-17" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/C1/messages");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bot dc-test");
    expect(calls[0]?.headers.get("Content-Type")).toStartWith("multipart/form-data; boundary=");
    const form = await calls[0]?.formData();
    expect([...(form?.keys() ?? [])].sort()).toEqual(["files[0]", "payload_json"]);
    expect(JSON.parse(String(form?.get("payload_json")))).toEqual({
      content: "image caption",
      attachments: [{ id: 0, filename: "shot.png" }],
      message_reference: { message_id: "m-9", fail_if_not_exists: false },
    });
    const upload = form?.get("files[0]");
    expect(upload).toBeInstanceOf(File);
    expect(upload).toMatchObject({ name: "shot.png", type: "image/png" });
    expect(upload instanceof Blob && [...new Uint8Array(await upload.arrayBuffer())]).toEqual([
      4, 5,
    ]);
  });

  test("reacts with the URL-encoded emoji using PUT", async () => {
    const calls = captureCalls();
    const runtime = DiscordProvider.create(
      { token: "dc-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "U1",
        { kind: "react", messageId: "m-9", emoji: "👍" },
        "react-1",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "m-9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://discord.com/api/v10/channels/C1/messages/m-9/reactions/%F0%9F%91%8D/@me",
    );
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bot dc-test");
    expect(calls[0]?.body).toBeNull();
    expect(
      await runtime.deliveryRoute?.(
        "U1",
        { kind: "react", messageId: "m-9", emoji: "👍", remove: true },
        "react-2",
        { channelId: "C1" },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "m-9" });
    expect(calls[1]?.url).toBe(
      "https://discord.com/api/v10/channels/C1/messages/m-9/reactions/%F0%9F%91%8D/@me",
    );
    expect(calls[1]?.method).toBe("DELETE");
  });

  test("posts typing into the supplied channel", async () => {
    const calls = captureCalls();
    const runtime = DiscordProvider.create(
      { token: "dc-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    if (runtime.typingRoute === undefined) throw new Error("discord has no typing route");
    await runtime.typingRoute.pulse(await runtime.typingRoute.open("U1", { channelId: "C1" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/C1/typing");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bot dc-test");
    expect(calls[0]?.body).toBeNull();
  });

  test("posts text with a reply reference in the supplied channel", async () => {
    const calls = captureCalls();
    const runtime = DiscordProvider.create(
      { token: "dc-test" },
      {},
      () => undefined,
      injectedOptions(),
    );
    expect(
      await runtime.deliveryRoute?.(
        "U1",
        { kind: "message", parts: [{ kind: "text", text: "hello" }] },
        "reply-1",
        {
          channelId: "C1",
          replyToMessageId: "m-9",
        },
      ),
    ).toEqual({ value: "accepted", externalMessageId: "m-17" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/C1/messages");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bot dc-test");
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(await calls[0]?.json()).toEqual({
      content: "hello",
      message_reference: { message_id: "m-9", fail_if_not_exists: false },
    });
  });
});
