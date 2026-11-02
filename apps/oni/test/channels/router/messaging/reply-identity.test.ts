import { describe, expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { createReplyMessaging } from "../../../../src/bundles/messaging/reply.js";
import type { ConversationBinding } from "../../../../src/bundles/message-ports.js";
import { unconfiguredChannelStores } from "../../../../../../packages/channels/src/router/stores.js";
import { effectFailure } from "../../../../../../packages/channels/test/helpers/effect-failure.js";

const binding: ConversationBinding = {
  surface: "instagram",
  externalId: "500",
  actorId: "",
  channelId: "t-1",
  messageId: "ig-1",
  dm: true,
};

/**
 * The reply door's identity is decided once at preflight and again at send
 * (#1569 lane 7): a route that left between the two is an admission
 * conflict, never a send through whatever is left.
 */
describe("the reply door's instance", () => {
  test("a surface whose only route left between preflight and send is an admission conflict", async () => {
    let routes = new Map([["channel:instagram:main", { platform: "instagram", identity: "owner" as const }]]);
    const door = createReplyMessaging({
      stores: unconfiguredChannelStores(() => 1),
      transaction: (effect) => effect,
      routes: () => routes,

      deliver: () => {
        throw new Error("never reached");
      },
      publish: () => undefined,
    });
    routes = new Map();
    expect(
      await effectFailure(
        door.send({ messageId: "m-1", traceId: "t", senderId: "resident", binding, payload: Outbound.payload("hi"), at: 1 }),
      ),
    ).toMatchObject({ _tag: "SendAdmissionConflict", message: "reply admission changed: no_route" });
  });
});
