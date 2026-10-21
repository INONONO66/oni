import { expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { deliveryFixture, installDeliveryFetch } from "./helpers/delivery";

// #1569: Slack rides the agent-messenger SDK; its physical evidence is pinned over the SDK error shapes in slack-surface.test.ts.
for (const provider of ["discord", "telegram"] as const) {
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
