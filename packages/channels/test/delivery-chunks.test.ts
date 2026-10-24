import { expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { deliveryFixture, installDeliveryFetch } from "./helpers/delivery";

for (const provider of ["discord", "discord-owner", "telegram"] as const) {
  test(`${provider}: chunk delivery reports the final distinct message id`, async () => {
    let sends = 0;
    const restore = installDeliveryFetch(() => {
      sends++;
      return Response.json({ id: String(sends), ok: true, result: { message_id: sends } });
    });
    try {
      const { adapter, address, limit } = deliveryFixture(provider);
      const payload = Outbound.payload("X".repeat(limit + 1));
      expect(await adapter.deliver(address, payload, "chunks")).toEqual({ value: "sent", externalMessageId: "2" });
      expect(await adapter.deliver(address, payload, "chunks")).toEqual({ value: "sent", externalMessageId: "2" });
      expect(sends).toBe(2);
    } finally { restore(); }
  });

  test.each(["refusal", "missing-id", "reset"] as const)(
    `${provider}: partial delivery followed by %s retains same-key custody`, async (failure) => {
      let sends = 0;
      const restore = installDeliveryFetch(() => {
        sends++;
        if (sends === 1) return Response.json({ id: "1", ok: true, result: { message_id: 1 } });
        if (failure === "reset") throw Object.assign(new Error("lost ACK"), { code: "ECONNRESET" });
        return failure === "missing-id"
          ? Response.json({ ok: true, result: {} })
          : Response.json({ message: "refused", ok: false, error_code: 403, description: "refused" }, { status: 403 });
      });
      try {
        const { adapter, address, limit } = deliveryFixture(provider);
        const send = () => adapter.deliver(address, Outbound.payload("X".repeat(limit * 2 + 1)), "partial");
        expect(await send()).toEqual({ value: "unknown" });
        expect(await send()).toEqual({ value: "unknown" });
        expect(sends).toBe(2);
      } finally { restore(); }
    },
  );
}
