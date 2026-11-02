import { ledger, resetLedger } from "../../../../../../packages/channels/test/helpers/ledger.js";
import { Effect } from "effect";
import { channelRequests } from "../../helpers/channel-requests.js";
import { channelTransaction } from "../../../../../../packages/channels/test/helpers/channel-transaction.js";
import { runEffect } from "../../../../../../packages/channels/test/helpers/effect.js";
import { seededRequests } from "../../../../../../packages/channels/test/helpers/requests.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createExistingAgentMessaging } from "../../../../src/bundles/messaging/send.js";
import { buildAwaitedSendInput, buildGrant, buildSendInput, registerAgentFixture } from "../../../../../../packages/channels/test/helpers/messaging.js";
import { makeRouter, resetStores } from "../_router-fixture.js";
import type { ChannelDeliveryRoute } from "../../../../src/bundles/messaging/message-ports.js";

beforeEach(() => {
  resetStores();
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});
afterEach(() => {
  resetLedger();
});

for (const input of [buildSendInput(), buildAwaitedSendInput()]) {
  test(`${input.operation} send receipt preserves the provider refusal reason`, async () => {
    const messaging = createExistingAgentMessaging({
      requests: channelRequests(seededRequests()),
      stores: ledger().stores,
      transaction: channelTransaction,
      grants: () => [buildGrant("grant:sender->target")],
      routes: () => new Map([["qa", { platform: "qa", identity: "bot" }]]),
      publish: () => undefined,
      deliver: () => ({ value: "rejected", reason: "media_too_large audio 60>50" }),
    });
    const receipt = await runEffect(messaging.send(input));
    expect(receipt).toMatchObject({
      kind: "sent",
      operation: input.operation,
      delivery: "rejected",
      reason: "media_too_large audio 60>50",
    });
  });

  test(`${input.operation} router actor delivery preserves the provider refusal reason`, async () => {
    const router = makeRouter({
      messaging: {
        grants: () => [buildGrant("grant:sender->target")],
        deliveryRoutes: new Map<string, ChannelDeliveryRoute>([
          ["qa", { platform: "qa", identity: "bot", deliver: async () => ({ value: "rejected", reason: "media_too_large audio 60>50" }) }],
        ]),
      },
    });
    const result = await runEffect(router.ingest(
      { kind: "session", id: input.senderId },
      {
        to: { kind: "actor", actorId: input.target.actorId },
        type: "message",
        content: { kind: "message", parts: [{ kind: "audio", ref: "/voice.ogg" }] },
        ...(input.requestSpec === undefined ? {} : { deadline: input.requestSpec.deadline }),
      },
    ));
    expect(result.status === "executed" ? result.delivery : result).toStrictEqual({
      kind: "actor",
      value: "rejected",
      reason: "media_too_large audio 60>50",
    });
  });
}

for (const value of ["accepted", "rejected", "unknown"] as const) {
  test(`actor transport preserves the ${value} receipt under a stable idempotency key`, async () => {
    // Given a real send kernel and a transport with an explicit receipt.
    const keys: string[] = [];
    const messaging = createExistingAgentMessaging({
      requests: channelRequests(seededRequests()),
      stores: ledger().stores,
    transaction: channelTransaction,
      grants: () => [buildGrant("grant:sender->target")],
      routes: () => new Map([["qa", { platform: "qa", identity: "bot" }]]),
      publish: () => undefined,
      deliver: async (message: Parameters<Parameters<typeof createExistingAgentMessaging>[0]["deliver"]>[0]) => {
        keys.push(message.idempotencyKey);
        return { value };
      },
    });
    const input = buildSendInput();
    // When the same delivery is retried.
    const receipts = await runEffect(Effect.all([messaging.send(input), messaging.send(input)], { concurrency: 2 }));
    // Then actor classification is preserved, not collapsed to success/failure.
    expect(keys).toEqual([input.messageId, input.messageId]);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ kind: "sent", delivery: value });
    }
  });
}
