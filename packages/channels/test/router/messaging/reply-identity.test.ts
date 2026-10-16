import { describe, expect, test } from "bun:test";
import { Outbound } from "@openomni/protocol";
import { type ConversationBinding, createReplyMessaging } from "../../../src/router/messaging/reply";
import { unconfiguredChannelStores } from "../../../src/router/stores";
import { effectFailure } from "../../helpers/effect-failure";

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
    let routes = new Set(["instagram:owner"]);
    const door = createReplyMessaging({
      stores: unconfiguredChannelStores(() => 1),
      transaction: (effect) => effect,
      routes: () => routes,
      autoReplies: () => new Set(["instagram:owner"]),
      deliver: () => {
        throw new Error("never reached");
      },
      publish: () => undefined,
    });
    routes = new Set();
    expect(
      await effectFailure(
        door.send({ messageId: "m-1", traceId: "t", senderId: "resident", binding, payload: Outbound.payload("hi"), at: 1 }),
      ),
    ).toMatchObject({ _tag: "SendAdmissionConflict", message: "reply admission changed: no_route" });
  });
});
