import { ledger, resetLedger } from "../../../../../../packages/channels/test/helpers/ledger.js";
import { channelRequests } from "../../helpers/channel-requests.js";
import { channelTransaction } from "../../../../../../packages/channels/test/helpers/channel-transaction.js";
import { runEffect } from "../../../../../../packages/channels/test/helpers/effect.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Gateway } from "@oni/protocol";
import { createExistingAgentMessaging } from "../../../../src/bundles/messaging/send.js";
import { seededRequests } from "../../../../../../packages/channels/test/helpers/requests.js";

// Storage.initialize no-ops when an earlier test file left an initialized
// ":memory:" adapter behind, which would resurrect its registered actors —
// reset first so each test registers the fixture exactly once on a fresh db.
beforeEach(() => {
  resetLedger();
});

afterEach(() => {
  resetLedger();
});

for (const at of [1, 1.5]) {
  test(`send admits a valid Gateway.SendInput whose instant is at=${at}`, async () => {
    for (const id of ["sender", "target"]) {
      ledger().stores.actors.registerIdentity({
        id,
        kind: "ai_agent",
        trustTier: "collaborator",
        createdAt: 0,
        updatedAt: 0,
      });
    }
    ledger().stores.actors.registerEndpoint({
      id: "endpoint",
      actorId: "target",
      channel: "qa",
      externalId: "target-1",
      createdAt: 0,
      updatedAt: 0,
    });
    const input = Gateway.SendInput.parse({
      messageId: "fractional-send",
      traceId: "fractional",
      senderId: "sender",
      target: { actorId: "target" },
      operation: "fire_and_forget",
      payload: { kind: "message", parts: [{ kind: "text", text: "test" }] },
      at,
    });
    const grant = Gateway.SenderTargetGrant.parse({
      id: "grant",
      senderId: "sender",
      targetActorId: "target",
      operations: ["fire_and_forget"],
    });
    let deliveries = 0;
    const messaging = createExistingAgentMessaging({
      routes: () => new Map([["qa", { platform: "qa", identity: "bot" }]]),
      requests: channelRequests(seededRequests()),
      stores: ledger().stores,
    transaction: channelTransaction,
      grants: () => [grant],
      deliver: () => {
        deliveries += 1;
        return { value: "accepted" as const };
      },
      publish: () => undefined,
    });
    expect(messaging.preflight(input)).toBeUndefined();
    expect((await runEffect(messaging.send(input))).kind).toBe("sent");
    expect(deliveries).toBe(1);
  });
}
