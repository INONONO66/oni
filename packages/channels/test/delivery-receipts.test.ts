import { expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { injectedOptions } from "./helpers/injected";
import { SlackAdapter } from "../src/provider/slack/surface";
import { deliveryFixture, installDeliveryFetch } from "./helpers/delivery";

for (const provider of ["discord", "slack", "telegram"] as const) {
  for (const failure of [
    "forbidden",
    "partial",
    "network",
    "server",
    "malformed",
    "missing_id",
    "accepted",
  ] as const) {
    test(`${provider} classifies ${failure} at its real HTTP delivery boundary`, async () => {
      let sends = 0;
      const restoreFetch = installDeliveryFetch(() => {
        sends += 1;
        if (failure === "network") throw new TypeError("connection lost after transmission");
        if (
          failure === "forbidden" ||
          failure === "server" ||
          (failure === "partial" && sends === 2)
        )
          return Response.json(
            { ok: false, error: "forbidden", description: "forbidden" },
            { status: failure === "server" ? 503 : 403 },
          );
        if (failure === "malformed") return new Response("not-json");
        if (failure === "missing_id") return Response.json({ ok: true, result: {} });
        return Response.json({
          id: "physical-id",
          ok: true,
          ts: "physical-id",
          result: { message_id: "physical-id" },
        });
      });
      const { adapter, address } = deliveryFixture(provider);
      try {
        const content = failure === "partial" ? "X".repeat(8000) : "SENTINEL";
        const receipt = await adapter.deliver(address, Outbound.payload(content), "stable-key");
        expect(sends).toBe(failure === "partial" ? 2 : 1);
        expect(receipt).toEqual(
          failure === "accepted"
            ? { value: "sent", externalMessageId: "physical-id" }
            : { value: failure === "forbidden" ? "not_sent" : "unknown" },
        );
        if (receipt.value !== "not_sent") {
          expect(await adapter.deliver(address, Outbound.payload(content), "stable-key")).toEqual(receipt);
          expect(sends).toBe(failure === "partial" ? 2 : 1);
        }
      } finally {
        restoreFetch();
      }
    });
  }
}

test("invalid Slack destination throws before any HTTP request or external receipt", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const adapter = new SlackAdapter({ botToken: "token", appToken: "app" }, {}, () => undefined, injectedOptions());
    await expect(adapter.deliver("USER", Outbound.payload("message"), "invalid")).rejects.toMatchObject({
      _tag: "SlackEndpointKeyError",
    });
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
