import { describe, expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { createDiscordProvider } from "../src/provider/discord/provider";
import { injectedOptions } from "./helpers/injected";
import { recordHttp } from "./helpers/http";
import { fakeDiscordSdk } from "./helpers/discord-sdk";
import { discordDmChannel } from "../src/provider/discord/delivery";

describe("Discord outbound SDK requests", () => {
  test("DM preflight keeps the underlying SDK failure in its typed cause", async () => {
    const fake = fakeDiscordSdk();
    fake.client.fail("createDm", new Error("missing SEND_MESSAGES permission"));
    await expect(discordDmChannel(fake.client, "U1")).rejects.toMatchObject({
      _tag: "DeliveryNotSent",
      cause: "missing SEND_MESSAGES permission",
    });
    expect(fake.client.calls).toHaveLength(0);
  });

  test.each(["sync", "async"] as const)("replacement adds after a %s settled removal", async (mode) => {
    const fake = fakeDiscordSdk();
    const settled = Object.assign(new Error("already removed"), { httpStatus: 404 });
    let removals = 0;
    fake.client.removeReaction = () => {
      removals++;
      if (mode === "sync") throw settled;
      return Promise.reject(settled);
    };
    const runtime = createDiscordProvider(fake.sdk).create({ token: "dc-test" }, {}, () => undefined, injectedOptions());
    expect(await runtime.deliveryRoute?.("U1", {
      kind: "react", messageId: "m-17", emoji: "✅", replaces: "👀",
    }, "settled-reaction", { channelId: "D-owner" })).toEqual({
      value: "accepted", externalMessageId: "m-17",
    });
    expect(removals).toBe(1);
    expect(fake.client.calls).toEqual([
      { method: "addReaction", channelId: "D-owner", messageId: "m-17", emoji: "✅" },
    ]);
  });

  test("opens the scripted DM once per key and replaces its reaction in order", async () => {
    const fake = fakeDiscordSdk();
    const runtime = createDiscordProvider(fake.sdk).create({ token: "dc-test" }, {}, () => undefined, injectedOptions());
    const send = () => runtime.deliveryRoute?.("U1", Outbound.payload("hello"), "dm-key");
    expect(await send()).toEqual({ value: "accepted", externalMessageId: "m-17" });
    expect(await send()).toEqual({ value: "accepted", externalMessageId: "m-17" });
    expect(fake.client.calls).toEqual([
      { method: "createDm", channelId: "U1" },
      { method: "createMessage", channelId: "D-owner" },
    ]);
    expect(await runtime.deliveryRoute?.("U1", {
      kind: "react", messageId: "m-17", emoji: "✅", replaces: "👀",
    }, "reaction-key", { channelId: "D-owner" })).toEqual({ value: "accepted", externalMessageId: "m-17" });
    expect(fake.client.calls.slice(2)).toEqual([
      { method: "removeReaction", channelId: "D-owner", messageId: "m-17", emoji: "👀" },
      { method: "addReaction", channelId: "D-owner", messageId: "m-17", emoji: "✅" },
    ]);
  });

  test("uploads bytes with filename, MIME, caption, destination, and reply reference", async () => {
    const wire = recordHttp(() => Response.json({ id: "m-17" }));
    try {
      const runtime = createDiscordProvider().create(
        { token: "dc-test" }, {}, () => undefined,
        { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array([4, 5]), name: "shot.png", mime: "image/png" }) },
      );
      expect(await runtime.deliveryRoute?.("U1", {
        kind: "message",
        parts: [{ kind: "image", ref: "/shot.png", name: "shot.png", caption: "image caption" }],
      }, "media-1", { channelId: "C1", replyToMessageId: "m-9" })).toEqual({
        value: "accepted", externalMessageId: "m-17",
      });
      expect(wire.requests).toHaveLength(1);
      const request = wire.requests[0];
      if (!request) throw new Error("Missing request");
      expect(new URL(request.url).pathname).toBe("/api/v10/channels/C1/messages");
      const form = await request.formData();
      const payload = form.get("payload_json");
      if (typeof payload !== "string") throw new Error("Missing payload");
      expect(JSON.parse(payload)).toEqual({
        content: "image caption",
        message_reference: { message_id: "m-9", fail_if_not_exists: false },
        attachments: [{ id: 0, filename: "shot.png" }],
      });
      const file = form.get("files[0]");
      if (!(file instanceof File)) throw new Error("Missing file");
      expect(file.name).toBe("shot.png");
      expect(file.type).toBe("image/png");
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([4, 5]);
    } finally { wire.restore(); }
  });

  test.each([
    { kind: "audio", name: "note.ogg", mime: "audio/ogg" },
    { kind: "video", name: "clip.webm", mime: "video/webm" },
  ] as const)("uploads $kind bytes as a files[0] attachment", async ({ kind, name, mime }) => {
    const wire = recordHttp(() => Response.json({ id: "m-18" }));
    try {
      const runtime = createDiscordProvider().create(
        { token: "dc-test" }, {}, () => undefined,
        { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array([6, 7]), name, mime }) },
      );
      expect(await runtime.deliveryRoute?.("U1", {
        kind: "message",
        parts: [{ kind, ref: "/clip", name, durationMs: 3_000 }],
      }, `media-${kind}`, { channelId: "C1" })).toEqual({ value: "accepted", externalMessageId: "m-18" });
      const form = await wire.requests[0]?.formData();
      const file = form?.get("files[0]");
      if (!(file instanceof File)) throw new Error("Missing file");
      expect(file.name).toBe(name);
      expect(file.type).toBe(mime);
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([6, 7]);
    } finally { wire.restore(); }
  });

  test("an oversize video is rejected before any request, its reason naming the limit", async () => {
    const wire = recordHttp(() => Response.json({ id: "never" }));
    try {
      const limit = 20 * 1024 * 1024;
      const runtime = createDiscordProvider().create(
        { token: "dc-test" }, {}, () => undefined,
        { ...injectedOptions(), media: async () => ({ bytes: new Uint8Array(limit + 1), name: "big.mp4", mime: "video/mp4" }) },
      );
      const receipt = await runtime.deliveryRoute?.("U1", {
        kind: "message", parts: [{ kind: "video", ref: "/big.mp4" }],
      }, "media-big", { channelId: "C1" });
      expect(receipt).toEqual({ value: "rejected", reason: `media_too_large video ${limit + 1}>${limit}` });
      expect(wire.requests).toHaveLength(0);
    } finally { wire.restore(); }
  });

  test.each([404, 403, 503])("replacement deletion HTTP %i only settles an absent reaction", async (status) => {
    const wire = recordHttp((request) => request.method === "DELETE"
      ? Response.json({ message: "deletion refused" }, { status })
      : new Response(null, { status: 204 }));
    try {
      const runtime = createDiscordProvider().create({ token: "dc-test" }, {}, () => undefined, injectedOptions());
      const send = () => runtime.deliveryRoute?.("U1", {
        kind: "react", messageId: "m-9", emoji: "✅", replaces: "👀",
      }, "reaction", { channelId: "C1" });
      expect(await send()).toEqual(status === 404
        ? { value: "accepted", externalMessageId: "m-9" }
        : { value: status === 403 ? "rejected" : "unknown" });
      expect(wire.requests.map(request => request.method)).toEqual(status === 404 ? ["DELETE", "PUT"] : ["DELETE"]);
      expect(decodeURIComponent(wire.requests[0]?.url ?? "")).toContain("/channels/C1/messages/m-9/reactions/👀/@me");
      if (status === 503) {
        expect(await send()).toEqual({ value: "unknown" });
        expect(wire.requests).toHaveLength(1);
      }
    } finally { wire.restore(); }
  });
});
