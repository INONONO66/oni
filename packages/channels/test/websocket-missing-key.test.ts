import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Channel } from "@oni/protocol";
import { WebSocketHandler } from "../src/websocket";
import { runEffect } from "./helpers/effect";
import { testWebSocketId } from "./helpers/websocket-server";

const connection = {
  surfaceKey: "ws::dm:c1",
  authenticated: true,
  externalId: "connection:c1",
} as const;

function handlerWith(sink: (message: Channel.InboundMessage) => void): WebSocketHandler {
  return new WebSocketHandler(
    (message) => Effect.sync(() => {
      sink(message);
    }),
    () => undefined,
    { now: () => 1_000, id: testWebSocketId() },
  );
}

describe("websocket frame key admission (#1245)", () => {
  it("refuses a keyless frame with a typed refusal and never reaches the handler", async () => {
    const inbound: Channel.InboundMessage[] = [];
    const handler = handlerWith((message) => inbound.push(message));

    const outcome = await runEffect(
      handler.handleFrame(connection, JSON.stringify({ text: "no key" })),
    );

    expect(outcome).toEqual({ admitted: false, reason: "missing_key" });
    expect(inbound).toEqual([]);
  });

  it("admits a keyed frame under exactly the caller's key", async () => {
    const inbound: Channel.InboundMessage[] = [];
    const handler = handlerWith((message) => inbound.push(message));

    const outcome = await runEffect(
      handler.handleFrame(connection, JSON.stringify({ text: "keyed", eventId: "evt-9" })),
    );

    expect(outcome).toEqual({ type: "receipt", status: "accepted" });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.facts.eventId).toBe("evt-9");
  });
});
