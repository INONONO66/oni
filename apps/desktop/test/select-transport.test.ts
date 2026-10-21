import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { UIMessage } from "ai";
import { selectChatTransport } from "../src/renderer/chat/select-transport";
import { testId } from "./helpers/platform";

/**
 * Which transport the renderer speaks through is one decision, and it is made
 * here rather than inside `app.tsx` so it can be asserted without mounting a
 * window. There is no fallback: with no usable gateway the answer is a named
 * refusal, and the composer is disabled on it, because a shell that fell back
 * to anything else would show a fluent, entirely fictional conversation.
 */

describe("the transport follows the endpoint", () => {
  test("Given an endpoint, When selected, Then the gateway answers with a usable transport", () => {
    const selected = selectChatTransport({ url: "ws://127.0.0.1:3000/ws" }, testId);

    expect(selected.kind).toBe("gateway");
    expect(typeof selected.transport?.sendMessages).toBe("function");
    expect(typeof selected.transport?.reconnectToStream).toBe("function");
  });

  test("Given an endpoint with a token, When selected, Then it is offered as the auth subprotocol", () => {
    // `["auth", token]` is the offer `packages/channels/src/authn/websocket.ts`
    // reads: the literal `auth` marks the pair, and the next protocol IS the
    // credential. Sending the bare token would authenticate nothing.
    expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws", token: "s3cret" }, testId)).toMatchObject({
      kind: "gateway",
      protocols: ["auth", "s3cret"],
    });
  });

  test("Given an endpoint without a token, When selected, Then no subprotocol is offered", () => {
    // A loopback gateway with no configured token rejects an `auth` offer it
    // cannot match, so an empty offer is not the same as an absent one.
    expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws" }, testId)).not.toHaveProperty("protocols");
    expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws", token: "" }, testId)).not.toHaveProperty(
      "protocols",
    );
  });

  test("Given a token no subprotocol can carry, When selected, Then it is refused by name", () => {
    // `new WebSocket(url, protocols)` THROWS a bare SyntaxError on a protocol
    // that is not an HTTP token, and it throws from inside the transport's
    // first send — so an operator with a space in ONI_WS_TOKEN would get
    // "Wrong protocol for WebSocket" on their first message and nothing
    // pointing at the variable that caused it. The daemon puts no character
    // constraint on the token, so this is reachable by configuration.
    for (const token of ["has space", "tab\there", 'quote"d', "comma,d", "sla/sh"]) {
      const selected = selectChatTransport({ url: "ws://127.0.0.1:3000/ws", token }, testId);

      expect(selected.kind).toBe("misconfigured");
      expect(selected.transport).toBeNull();
      expect(selected.kind === "misconfigured" && selected.problem).toMatch(/ONI_WS_TOKEN/);
      // The value is a credential and the message reaches the screen.
      expect(selected.kind === "misconfigured" && selected.problem).not.toContain(token);
    }
  });

  test("Given a token of ordinary credential characters, When selected, Then it is accepted", () => {
    // The refusal above must not reject what a token generator actually emits:
    // base64url, hex, and JWT-shaped values are all HTTP tokens.
    for (const token of ["s3cret", "a-b_c.d~e", "YWJjZDEyMzQ", "ey.J9.sig", "0123456789abcdef"]) {
      expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws", token }, testId)).toMatchObject({
        protocols: ["auth", token],
      });
    }
  });
});

/**
 * The offer, on a real upgrade.
 *
 * Asserting `protocols` on the returned object only proves this module agrees
 * with itself — the load-bearing claim is that the pair reaches the server's
 * `Sec-WebSocket-Protocol` header in the order the gateway's authenticator
 * reads it. So the transport is pointed at a real socket server and the header
 * is read off the upgrade request.
 */
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serveUpgrade() {
  let header: string | null = null;
  let upgraded: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    upgraded = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request, self) {
      header = request.headers.get("sec-websocket-protocol");
      upgraded?.();
      // The token is never echoed back as the negotiated protocol — the
      // gateway answers `auth`. Narrow the OFFER on the request (as
      // packages/channels/src/websocket.ts does) instead of passing a response
      // header: Bun 1.3.6 writes an explicit response protocol twice, which the
      // browser client rejects as a failed handshake.
      if (header !== null) request.headers.set("sec-websocket-protocol", "auth");
      return self.upgrade(request)
        ? undefined
        : new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws: ServerWebSocket<undefined>) {
        ws.send(JSON.stringify({ type: "response", text: "ok" }));
      },
    },
  });
  servers.push(server);
  return { header: () => header, port: server.port, seen };
}

const PROMPT: readonly UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
];

async function offeredProtocols(token?: string) {
  const wire = serveUpgrade();
  const selected = selectChatTransport(
    {
      url: `ws://127.0.0.1:${wire.port}/ws`,
      ...(token === undefined ? {} : { token }),
    },
    testId,
  );
  if (selected.kind !== "gateway") throw new Error("Expected a configured gateway");
  const sent = selected.transport.sendMessages({
    trigger: "submit-message",
    chatId: "chat-1",
    messageId: undefined,
    messages: [...PROMPT],
    abortSignal: undefined,
  });
  await wire.seen;
  await sent;
  return wire.header();
}

describe("the token reaches the wire", () => {
  test("Given a token, When the transport connects, Then the upgrade carries auth then the token", async () => {
    const header = await offeredProtocols("s3cret");
    expect(header?.split(",").map((part) => part.trim())).toEqual(["auth", "s3cret"]);
  });

  test("Given no token, When the transport connects, Then the upgrade offers no protocol", async () => {
    expect(await offeredProtocols()).toBeNull();
  });
});
