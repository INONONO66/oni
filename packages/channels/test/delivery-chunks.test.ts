import { expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { deliveryFixture } from "./helpers/delivery";

test.each(["discord", "telegram"] as const)("successful chunk delivery keeps final platform id for %s", async (provider) => {
  const fixture = deliveryFixture(provider);
  const receipt = await fixture.adapter.deliver(
    fixture.address,
    Outbound.payload("X".repeat(fixture.limit + 1)),
    `${provider}-chunks`,
  );
  expect(receipt.value).toBe("sent");
  expect(receipt.externalMessageId).toBeDefined();
  expect(fixture.client.calls.length).toBeGreaterThanOrEqual(2);
});
