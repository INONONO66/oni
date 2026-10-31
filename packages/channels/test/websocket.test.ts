import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ChannelsFailure } from "../src/errors";
import { testWebSocketId, websocketCallbacks } from "./helpers/websocket-server";
import { runEffect } from "./helpers/effect";
import type { Channel } from "@oni/protocol";
import { z } from "zod";
import type { ChannelAuthnDecisionObserver } from "../src/authn/types";
import type { PublishPort } from "../src/types";
import { WebSocketHandler, type WsConnectionData } from "../src/websocket";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];
const noopPublish: PublishPort = () => undefined;

function wsOptions(): { now: () => number; id: () => string } {
  return { now: () => 1_000, id: testWebSocketId() };
}

function createHandler(
  decisions: ChannelAuthnDecision[] = [],
  publish: PublishPort = noopPublish,
): WebSocketHandler {
  return new WebSocketHandler(() => Effect.void, publish, {
    ...wsOptions(),
    token: "secret-token",
    onAuthDecision: (decision) => {
      decisions.push(decision);
    },
  });
}

function createUpgradeServer() {
  type Options = Parameters<Parameters<WebSocketHandler["handleUpgrade"]>[1]["upgrade"]>[1];
  let options: Options | undefined;
  return {
    server: {
      upgrade(_req: Request, nextOptions: Options): boolean {
        options = nextOptions;
        return true;
      },
    },
    get options() {
      return options;
    },
  };
}

describe("WebSocketHandler authentication", () => {
  it("accepts the canonical protocol and records authentication", () => {
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws", {
      headers: { "Sec-WebSocket-Protocol": "auth, secret-token" },
    });

    expect(handler.handleUpgrade(req, upgrade.server)).toBeUndefined();
    expect(req.headers.get("sec-websocket-protocol")).toBe("auth");
    expect(upgrade.options?.data.authenticated).toBe(true);
    expect(decisions.map((decision) => decision.verdict)).toEqual(["allow"]);
  });

  it("rejects missing websocket auth before upgrade", () => {
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    let upgrades = 0;
    const response = handler.handleUpgrade(new Request("http://localhost/ws"), {
      upgrade() {
        upgrades += 1;
        return true;
      },
    });

    expect(response?.status).toBe(401);
    expect(upgrades).toBe(0);
    expect(decisions.map((decision) => decision.verdict)).toEqual(["deny"]);
  });

  it("does not bind an actor on tokenless bootstrap", () => {
    const handler = new WebSocketHandler(() => Effect.void, noopPublish, wsOptions());
    const upgrade = createUpgradeServer();

    expect(
      handler.handleUpgrade(new Request("http://localhost/ws?actor=alice"), upgrade.server),
    ).toBeUndefined();
    expect(upgrade.options?.data.externalId).toMatch(/^connection:/);
    expect(upgrade.options?.data).not.toMatchObject({ externalId: "alice" });
  });
});

describe("WebSocketHandler ingress and receipts", () => {
  function connection(data: WsConnectionData) {
    const sent: string[] = [];
    return {
      sent,
      ws: {
        data,
        send: (message: string) => {
          sent.push(message);
        },
      },
    };
  }

  it("binds one first surface frame to the socket and refuses redeclaration", async () => {
    const handler = createHandler();
    const { ws } = connection({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "connection:c1",
    });

    expect(await runEffect(handler.handleFrame(ws.data, JSON.stringify({ kind: "surface", machineId: "desk" }))))
      .toEqual({ type: "surface_bound", machineId: "desk" });
    expect(ws.data.machineId).toBe("desk");
    expect(await runEffect(handler.handleFrame(ws.data, JSON.stringify({ kind: "surface", machineId: "other" }))))
      .toEqual({ type: "error", reason: "surface_already_declared" });
    expect(ws.data.machineId).toBe("desk");
  });

  it("refuses a surface declaration after a message frame", async () => {
    const handler = createHandler();
    const { ws } = connection({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "connection:c1",
    });

    await runEffect(handler.handleFrame(ws.data, JSON.stringify({ text: "hello", eventId: "first" })));
    expect(await runEffect(handler.handleFrame(ws.data, JSON.stringify({ kind: "surface", machineId: "desk" }))))
      .toEqual({ type: "error", reason: "surface_already_declared" });
    expect(ws.data.machineId).toBeUndefined();
  });

  it("passes a declared frame identifier through as the deduplication key", async () => {
    let inbound: Channel.InboundMessage | undefined;
    const handler = new WebSocketHandler((message) => Effect.sync(() => {
      inbound = message;
    }), noopPublish, wsOptions());
    const { ws, sent } = connection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "connection:c1",
    });

    await websocketCallbacks(handler).message(
      ws,
      JSON.stringify({ text: "done", eventId: "frame-7", replyToId: "frame-7" }),
    );

    expect(inbound).toMatchObject({
      sender: { kind: "external", surface: "ws", externalId: "connection:c1" },
      facts: {
        surface: "ws",
        channelId: "ws::dm:c1",
        dm: true,
        render: "done",
        eventId: "frame-7",
        reply: { chain: ["frame-7"] },
      },
    });
    expect(sent).toEqual([JSON.stringify({ type: "receipt", status: "accepted" })]);
  });

  it.each([
    "",
    0,
    null,
  ])("refuses an unusable frame identifier %j instead of minting a key", async (identifier) => {
    let inbound: Channel.InboundMessage | undefined;
    const handler = new WebSocketHandler((message) => Effect.sync(() => {
      inbound = message;
    }), noopPublish, wsOptions());
    const { ws, sent } = connection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "connection:c1",
    });

    await websocketCallbacks(handler).message(
      ws,
      JSON.stringify({ text: "done", eventId: identifier, replyToId: identifier }),
    );

    expect(inbound).toBeUndefined();
    expect(sent).toEqual([JSON.stringify({ admitted: false, reason: "missing_key" })]);
  });

  it.each([
    ["{", "invalid_json"],
    ["[]", "invalid_frame"],
    ["{}", "text_required"],
    ['{"type":"request_answer","text":"must not become a message"}', "invalid_request_answer"],
  ])("rejects malformed frame %s before entering the handler", async (raw, reason) => {
    let entries = 0;
    const handler = new WebSocketHandler(() => Effect.sync(() => { entries += 1; }), noopPublish, wsOptions());
    const result = await runEffect(Effect.result(handler.handleFrame({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice",
    }, raw)));
    expect(result).toMatchObject({
      _tag: "Failure", failure: { _tag: "InvalidInbound", operation: "websocket.frame", reason },
    });
    expect(entries).toBe(0);
    if (result._tag === "Failure" && result.failure._tag === "InvalidInbound" && reason === "invalid_json") {
      expect(typeof result.failure.cause).toBe("string");
    }
  });

  it("defers ingress until execution and accepts binary frames exactly once", async () => {
    let entries = 0;
    const handler = new WebSocketHandler(() => Effect.sync(() => { entries += 1; }), noopPublish, wsOptions());
    const effect = handler.handleFrame({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice",
    }, Buffer.from(JSON.stringify({ text: "fixture", eventId: "event" })));
    expect(entries).toBe(0);
    expect(await runEffect(effect)).toEqual({ type: "receipt", status: "accepted" });
    expect(entries).toBe(1);
  });

  it("emits the frozen two-key receipt first, then session_bound carrying the admission", async () => {
    const result = {
      status: "executed",
      handle: { messageId: "in-1", target: "durable-1" },
      delivery: { kind: "session" },
    } as const;
    const handler = new WebSocketHandler(() => Effect.succeed(result), noopPublish, wsOptions());
    const { ws, sent } = connection({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice",
    });
    handler.ws.open(ws);

    await websocketCallbacks(handler).message(ws, JSON.stringify({ text: "bind me", eventId: "bind-1" }));

    expect(sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "receipt", status: "accepted" },
      { type: "session_bound", result },
    ]);
    // The accepted receipt is a frozen frame: exactly its base two keys.
    expect(Object.keys(z.record(z.string(), z.json()).parse(JSON.parse(sent[0] ?? "{}")))).toEqual([
      "type",
      "status",
    ]);
  });

  it("sends only the typed failure tag and never a receipt or private cause on handler refusal", async () => {
    const failure = new ChannelsFailure({ operation: "fixture.ingress", cause: "private credential" });
    const handler = new WebSocketHandler(() => Effect.fail(failure), noopPublish, wsOptions());
    const { ws, sent } = connection({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice",
    });
    await websocketCallbacks(handler).message(ws, JSON.stringify({ text: "fixture", eventId: "fixture-1" }));
    expect(sent).toEqual([JSON.stringify({ type: "error", reason: "ChannelsFailure" })]);
    expect(
      await runEffect(Effect.flip(handler.handleFrame(ws.data, '{"text":"fixture","eventId":"fixture-2"}'))),
    ).toBe(failure);
  });

  it("push returns an accepted receipt with a stable external message id", () => {
    const handler = createHandler();
    const { sent, ws } = connection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "alice",
    });
    handler.ws.open(ws);

    const receipt = handler.push("alice", "review", "message-1");
    expect(receipt).toEqual({ value: "accepted", externalMessageId: "message-1" });
    expect(JSON.parse(sent[0] ?? "null")).toEqual({
      type: "message",
      messageId: "message-1",
      text: "review",
    });
    handler.push("alice", "again", "message-2", []);
    expect(JSON.parse(sent[1] ?? "null")).toEqual({
      type: "message", messageId: "message-2", text: "again",
    });
  });

  it("push includes nonempty media parts in the outbound frame", () => {
    const handler = createHandler();
    const { sent, ws } = connection({
      surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice",
    });
    handler.ws.open(ws);
    const parts = [{ kind: "file", ref: "self:/report.pdf", name: "report.pdf", mime: "application/pdf" }] as const;

    expect(handler.push("alice", "report", "message-3", parts)).toEqual({
      value: "accepted", externalMessageId: "message-3",
    });
    expect(JSON.parse(sent[0] ?? "null")).toEqual({
      type: "message", messageId: "message-3", text: "report", parts,
    });
  });

  it("push without a live connection throws a typed delivery failure", () => {
    const handler = createHandler();
    let caught: Error | undefined;
    try {
      handler.push("ghost", "body", "message-x");
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }
    expect(caught).toMatchObject({ _tag: "DeliveryNotSent", operation: "websocket.push" });
  });

  it("reconnects without losing the current delivery target", () => {
    const handler = createHandler();
    const first = connection({ surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice" });
    const second = connection({
      surfaceKey: "ws::dm:c2",
      authenticated: true,
      externalId: "alice",
    });
    handler.ws.open(first.ws);
    handler.ws.open(second.ws);
    handler.ws.close(first.ws);
    handler.push("alice", "still here", "message-2");
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
  });
});
