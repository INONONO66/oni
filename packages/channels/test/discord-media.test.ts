import { describe, expect, test } from "bun:test";
import { createDiscordProvider } from "../src/provider/discord/provider";
import { injectedOptions } from "./helpers/injected";
import { recordHttp } from "./helpers/http";

describe("Discord outbound SDK requests", () => {
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
