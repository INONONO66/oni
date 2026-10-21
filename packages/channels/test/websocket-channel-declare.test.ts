import { describe, expect, it } from "bun:test";
import type { Provisioning } from "@oni/protocol";
import { Effect } from "effect";
import { WebSocketHandler } from "../src/websocket";
import type { PublishPort } from "../src/types";
import { runEffect } from "./helpers/effect";

const noopPublish: PublishPort = () => undefined;
const wsConfig = { now: () => 1_700_000_000_000, id: () => "frame-id" };
const connection = { surfaceKey: "ws::dm:c1", authenticated: true, externalId: "owner" };

/**
 * The Owner's channel declaration over the socket (#1569 lane 5b): the
 * perimeter decodes the frame and hands it to the app; a malformed one is
 * answered with a typed refusal naming the issues.
 */
describe("websocket channel_add frame", () => {
  it("decodes a well-formed declaration and hands it to the app untouched", async () => {
    let entries = 0;
    const handler = new WebSocketHandler(() => Effect.sync(() => { entries += 1; }), noopPublish, wsConfig);
    const frame: Provisioning.ChannelDeclareRequest = {
      type: "channel_add",
      requestId: "r-1",
      id: "channel:slack:owner",
      provider: "slack",
      identity: "owner",
      settings: { intake: "mentions_and_dms", autoReply: false },
      outbound: true,
      credential: { token: "xoxc-1", cookie: "d" },
    };
    expect(await runEffect(handler.handleFrame(connection, JSON.stringify(frame)))).toEqual(frame);
    expect(entries).toBe(0);
  });

  it("refuses a malformed declaration with its issues, before the app sees it", async () => {
    const handler = new WebSocketHandler(() => Effect.succeed(undefined), noopPublish, wsConfig);
    expect(
      await runEffect(
        handler.handleFrame(connection, JSON.stringify({ type: "channel_add", requestId: "r-2", provider: "slack" })),
      ),
    ).toMatchObject({ type: "channel_add_refused", requestId: "r-2", reason: "invalid_record", detail: expect.stringContaining("id") });
  });
});
