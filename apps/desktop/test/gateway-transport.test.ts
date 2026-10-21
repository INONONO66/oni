import { Chat } from "@ai-sdk/react";
import { SessionRead } from "@oni/protocol";
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket, Server } from "bun";
import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";
import {
  createGatewayChatTransport,
  SessionReadSupersessionError,
} from "../src/renderer/chat/gateway-transport";
import { TransportCapabilityError } from "../src/renderer/errors";
import { signal } from "./helpers";
import { upgradeWebSocket } from "./helpers/chat-server";
import { testId } from "./helpers/platform";

/**
 * The wire is asserted against a REAL socket, not a stubbed WebSocket. What
 * this file has to prove is that the oni frames (`receipt`, `message`,
 * `error`) reduce to the exact chunk sequence the AI SDK reads — and a fake
 * wire would let a wrong sequence pass because it would mirror the
 * implementation. The lifecycle tests inject a controllable socket solely to
 * force otherwise unreachable event orderings such as an old `close` after a
 * replacement has opened.
 *
 * Every wait is an EVENT: a served frame, a stream chunk, an `open`. There is no
 * sleep anywhere, so a slow machine cannot turn a pass into a flake or the
 * reverse.
 */

/** What the server was asked, in order — the client half of the wire. */
const receivedSchema = z.object({ text: z.string(), replyToId: z.string().optional() });
type Received = z.infer<typeof receivedSchema>;

/**
 * A server whose reply to each inbound frame is scripted: `script[n]` is sent
 * back for the nth message. Anything the script does not cover is answered with
 * an empty `message`, so a test that sends one more turn than it scripted fails
 * on the assertion rather than hanging.
 */
function serveWire(script: readonly (readonly Readonly<Record<string, string>>[])[]) {
  const received: Received[] = [];
  const protocols: (string | null)[] = [];
  let connectionCount = 0;
  let turn = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      protocols.push(request.headers.get("sec-websocket-protocol"));
      return self.upgrade(request)
        ? undefined
        : new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open() {
        connectionCount += 1;
      },
      message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
        received.push(
          receivedSchema.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString())),
        );
        const frames = script[turn] ?? [
          { type: "message", messageId: `message-${turn}`, text: "" },
        ];
        turn += 1;
        for (const frame of frames) ws.send(JSON.stringify(frame));
      },
    },
  });
  servers.push(server);
  return {
    connectionCount: () => connectionCount,
    received,
    protocols,
    url: `ws://127.0.0.1:${server.port}`,
  };
}

const servers: Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** Drain a chunk stream to completion. */
async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
}

let messageCounter = 0;
function userMessage(text: string): UIMessage {
  messageCounter += 1;
  return { id: `m${messageCounter}`, role: "user", parts: [{ type: "text", text }] };
}

function send(
  transport: ReturnType<typeof createGatewayChatTransport>,
  messages: readonly UIMessage[],
  abortSignal?: AbortSignal,
  chatId = "chat-1",
) {
  return transport.sendMessages({
    trigger: "submit-message",
    chatId,
    messageId: undefined,
    messages: [...messages],
    abortSignal,
  });
}

/** A browser socket whose close event can be held behind its replacement. */
class ControlledSocket {
  static readonly instances: ControlledSocket[] = [];

  readyState = 0;
  readonly sent: Received[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly errorListeners: (() => void)[] = [];
  private readonly messageListeners: ((event: { data: string | ArrayBuffer | Blob }) => void)[] =
    [];
  private readonly openListeners: (() => void)[] = [];

  constructor(_url: string, _protocols?: string | readonly string[]) {
    ControlledSocket.instances.push(this);
  }

  addEventListener(
    ...args:
      | ["open" | "close" | "error", () => void]
      | ["message", (event: { data: string | ArrayBuffer | Blob }) => void]
  ): void {
    if (args[0] === "message") {
      this.messageListeners.push(args[1]);
      return;
    }
    if (args[0] === "open") this.openListeners.push(args[1]);
    if (args[0] === "close") this.closeListeners.push(args[1]);
    if (args[0] === "error") this.errorListeners.push(args[1]);
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.openListeners) listener();
  }

  beginClose(): void {
    this.readyState = 2;
  }

  finishClose(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }

  fail(): void {
    for (const listener of this.errorListeners) listener();
  }

  respond(text: string): void {
    this.receive(JSON.stringify({ type: "message", messageId: `message-${text}`, text }));
  }

  receive(data: string | ArrayBuffer | Blob): void {
    const event = { data };
    for (const listener of this.messageListeners) listener(event);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(receivedSchema.parse(JSON.parse(data)));
  }

  close(): void {
    this.beginClose();
  }
}

function controlledTurn(messages = [userMessage("first")]) {
  ControlledSocket.instances.length = 0;
  const transport = createGatewayChatTransport({
    id: testId,
    url: "ws://controlled",
    WebSocketImpl: ControlledSocket,
  });
  const sending = send(transport, messages);
  const controlled = ControlledSocket.instances[0];
  if (controlled === undefined) throw new Error("socket was not constructed");
  controlled.open();
  return { transport, controlled, sending };
}

describe("createGatewayChatTransport", () => {
  test("empty history sends an empty prompt and does not offer reconnection", async () => {
    const { transport, controlled, sending } = controlledTurn([]);
    const stream = await sending;
    expect(controlled.sent).toEqual([{ text: "" }]);
    controlled.respond("empty");
    expect((await collect(stream)).map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
  });

  test("close before opening rejects and failed send closes its socket", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const opening = send(transport, [userMessage("opening")]);
    const first = ControlledSocket.instances[0];
    if (!first) throw new Error("Missing opening socket");
    const rejected = opening.then(
      () => {
        throw new Error("Opening unexpectedly succeeded");
      },
      (error: Error) => error,
    );
    first.finishClose();
    expect((await rejected).message).toContain("closed before opening");
    const sending = send(transport, [userMessage("send failure")]);
    const replacement = ControlledSocket.instances[1];
    if (!replacement) throw new Error("Missing replacement socket");
    replacement.open();
    replacement.beginClose();
    await expect(sending).rejects.toThrow("socket is not open");
    expect(replacement.readyState).toBe(2);
  });
  test("a server message becomes start / text-start / text-delta / text-end / finish", async () => {
    const { received, url } = serveWire([
      [
        { type: "receipt", status: "accepted" },
        { type: "message", messageId: "message-1", text: "the ledger appended" },
        { type: "error", message: "turn already completed" },
      ],
    ]);
    const transport = createGatewayChatTransport({ id: testId, url });

    const chunks = await collect(await send(transport, [userMessage("append it")]));

    expect(received).toEqual([{ text: "append it" }]);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const delta = chunks[2];
    if (delta?.type !== "text-delta") throw new Error("third chunk is not a text-delta");
    expect(delta.delta).toBe("the ledger appended");
    const start = chunks[1];
    const end = chunks[3];
    if (start?.type !== "text-start" || end?.type !== "text-end") {
      throw new Error("text part is not bracketed");
    }
    expect(delta.id).toBe(start.id);
    expect(end.id).toBe(start.id);
  });

  test("an error frame becomes one error chunk and closes the stream", async () => {
    const { url } = serveWire([
      [
        { type: "receipt", status: "accepted" },
        { type: "error", message: "text field required" },
      ],
    ]);
    const transport = createGatewayChatTransport({ id: testId, url });

    const chunks = await collect(await send(transport, [userMessage("")]));

    expect(chunks).toEqual([{ type: "error", errorText: "text field required" }]);
  });

  test("an outstanding server message id is echoed as replyToId on the next turn", async () => {
    const { received, url } = serveWire([
      [{ type: "message", messageId: "wait-7", text: "which branch?" }],
      [{ type: "message", messageId: "done", text: "done" }],
    ]);
    const transport = createGatewayChatTransport({ id: testId, url });

    await collect(await send(transport, [userMessage("ship it")]));
    await collect(await send(transport, [userMessage("main")]));

    expect(received).toEqual([{ text: "ship it" }, { text: "main", replyToId: "wait-7" }]);
  });

  test("reply ids stay with their chat when two turns share the socket", async () => {
    const { received, connectionCount, url } = serveWire([
      [{ type: "receipt", status: "accepted" }],
      [
        { type: "receipt", status: "accepted" },
        { type: "message", messageId: "wait-a", text: "answer A" },
        { type: "message", messageId: "wait-b", text: "answer B" },
      ],
      [{ type: "message", messageId: "done-a", text: "done A" }],
      [{ type: "message", messageId: "done-b", text: "done B" }],
    ]);
    const transport = createGatewayChatTransport({ id: testId, url });

    const first = send(transport, [userMessage("start A")], undefined, "chat-a");
    const second = send(transport, [userMessage("start B")], undefined, "chat-b");
    const [firstChunks, secondChunks] = await Promise.all([
      first.then(collect),
      second.then(collect),
    ]);
    expect(
      firstChunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["answer A"]);
    expect(
      secondChunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["answer B"]);
    await collect(await send(transport, [userMessage("reply A")], undefined, "chat-a"));
    await collect(await send(transport, [userMessage("reply B")], undefined, "chat-b"));

    expect(received).toEqual([
      { text: "start A" },
      { text: "start B" },
      { text: "reply A", replyToId: "wait-a" },
      { text: "reply B", replyToId: "wait-b" },
    ]);
    expect(connectionCount()).toBe(1);
  });

  test("preserves subprotocol offers on the real socket", async () => {
    const { protocols, url } = serveWire([
      [{ type: "message", messageId: "authenticated", text: "connected" }],
    ]);
    const transport = createGatewayChatTransport({
    id: testId,
      url,
      protocols: ["oni", "bearer.test-token"],
    });

    await collect(await send(transport, [userMessage("connect")]));

    expect(protocols).toEqual(["oni, bearer.test-token"]);
  });

  test("ignores malformed frames and retains unsolicited reply correlation", async () => {
    const { transport, controlled, sending } = controlledTurn();
    const collected = collect(await sending);
    for (const raw of [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ type: "message", messageId: "missing-text" }),
      JSON.stringify({ type: "message", text: "missing-id" }),
      JSON.stringify({ type: "message", messageId: 3, text: "wrong-id" }),
      JSON.stringify({ type: "receipt", status: "rejected" }),
      JSON.stringify({ type: "error", message: 3 }),
      JSON.stringify({ type: "future" }),
      new ArrayBuffer(0),
      new Blob(["binary"]),
    ])
      controlled.receive(raw);
    controlled.respond("first");
    expect(
      (await collected).filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["first"]);

    controlled.receive(
      JSON.stringify({ type: "message", messageId: "unsolicited", text: "next question" }),
    );
    const reply = collect(await send(transport, [userMessage("answer")]));
    controlled.respond("done");
    await reply;
    expect(controlled.sent).toEqual([
      { text: "first" },
      { text: "answer", replyToId: "unsolicited" },
    ]);
  });

  test("cancelling a stream invalidates its socket and clears reply correlation", async () => {
    const { transport, controlled, sending } = controlledTurn();
    const first = collect(await sending);
    controlled.respond("first");
    await first;
    const cancelled = await send(transport, [userMessage("cancel")]);
    await cancelled.cancel();
    expect(controlled.readyState).toBe(2);

    const retry = send(transport, [userMessage("retry")]);
    const replacement = ControlledSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement was not constructed");
    replacement.open();
    const result = collect(await retry);
    replacement.respond("done");
    await result;
    expect(replacement.sent).toEqual([{ text: "retry" }]);
  });

  test("rejects regeneration instead of appending the historical prompt again", async () => {
    const { received, url } = serveWire([]);
    const transport = createGatewayChatTransport({ id: testId, url });

    await expect(
      transport.sendMessages({
        trigger: "regenerate-message",
        chatId: "chat-1",
        messageId: "assistant-1",
        messages: [userMessage("do not duplicate")],
        abortSignal: undefined,
      }),
    ).rejects.toThrow(TransportCapabilityError);
    expect(received).toEqual([]);
  });

  test("an already-aborted turn never reaches the gateway", async () => {
    const { received, url } = serveWire([]);
    const transport = createGatewayChatTransport({ id: testId, url });
    const controller = new AbortController();
    controller.abort();

    const chunks = await collect(
      await send(transport, [userMessage("do not send")], controller.signal),
    );

    expect(chunks).toEqual([]);
    expect(received).toEqual([]);
  });

  test("an abort settles while the socket is still opening", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const controller = new AbortController();

    const aborted = send(transport, [userMessage("first")], controller.signal);
    const openingSocket = ControlledSocket.instances[0];
    if (openingSocket === undefined) throw new Error("opening socket was not constructed");
    controller.abort();

    expect(await collect(await aborted)).toEqual([]);
    expect(openingSocket.readyState).toBe(2);
  });

  test("aborting ends the stream", async () => {
    // The server never answers, so only the abort can end this read.
    const { url } = serveWire([[]]);
    const transport = createGatewayChatTransport({ id: testId, url });
    const controller = new AbortController();

    const stream = await send(transport, [userMessage("hang")], controller.signal);
    const reader = stream.getReader();
    const read = reader.read();
    controller.abort();

    expect((await read).done).toBe(true);
  });

  test("aborting one turn fails sibling turns on the invalidated socket", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const controller = new AbortController();

    const firstSend = send(transport, [userMessage("one")], controller.signal, "chat-a");
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const firstStream = await firstSend;
    const secondStream = await send(transport, [userMessage("two")], undefined, "chat-b");

    controller.abort();

    expect(await collect(firstStream)).toEqual([]);
    expect(await collect(secondStream)).toEqual([
      { type: "error", errorText: "gateway socket closed by another turn" },
    ]);
  });

  test("a completed turn cannot later close the shared socket", async () => {
    const { connectionCount, url } = serveWire([
      [{ type: "message", messageId: "first", text: "first" }],
      [{ type: "message", messageId: "second", text: "second" }],
    ]);
    const transport = createGatewayChatTransport({ id: testId, url });
    const firstController = new AbortController();

    await collect(await send(transport, [userMessage("one")], firstController.signal));
    firstController.abort();
    const chunks = await collect(await send(transport, [userMessage("two")]));

    expect(chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta === "second")).toBe(
      true,
    );
    expect(connectionCount()).toBe(1);
  });

  test("an unexpected socket close fails its pending turn", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });

    const sending = send(transport, [userMessage("one")]);
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const stream = await sending;
    controlled.finishClose();

    expect(await collect(stream)).toEqual([
      { type: "error", errorText: "gateway socket closed unexpectedly" },
    ]);
  });

  test("an old socket close cannot drain a turn on its replacement", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });

    const firstSend = send(transport, [userMessage("one")]);
    const firstSocket = ControlledSocket.instances[0];
    if (firstSocket === undefined) throw new Error("first socket was not constructed");
    firstSocket.open();
    const firstStream = await firstSend;
    firstSocket.respond("first");
    await collect(firstStream);

    firstSocket.beginClose();
    const secondSend = send(transport, [userMessage("two")]);
    const secondSocket = ControlledSocket.instances[1];
    if (secondSocket === undefined) throw new Error("replacement socket was not constructed");
    secondSocket.open();
    const secondStream = await secondSend;

    firstSocket.finishClose();
    secondSocket.respond("second");
    const chunks = await collect(secondStream);

    expect(chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta === "second")).toBe(
      true,
    );
  });

  test("a socket that fails while opening is replaced on retry", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });

    const failedSend = send(transport, [userMessage("first")]);
    const failedSocket = ControlledSocket.instances[0];
    if (failedSocket === undefined) throw new Error("failed socket was not constructed");
    const failure = failedSend.then(
      () => {
        throw new Error("opening failure unexpectedly succeeded");
      },
      (error: Error) => error,
    );
    failedSocket.fail();
    expect((await failure).message).toContain("gateway socket failed");

    const retry = send(transport, [userMessage("retry")]);
    const replacement = ControlledSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement socket was not constructed");
    replacement.open();
    const stream = await retry;
    replacement.respond("recovered");

    expect(
      (await collect(stream)).some(
        (chunk) => chunk.type === "text-delta" && chunk.delta === "recovered",
      ),
    ).toBe(true);
  });

  test("a session-level terminal page cannot settle another turn's pending chat", async () => {
    // Review r1 finding 1: with an established read subscription, a terminal
    // session page arriving before the second turn's message frame must not
    // close that turn's stream — both answers have to be emitted.
    const readFrame = z.object({ type: z.string().optional() }).loose();
    const sessionPage = (kind: "session_snapshot" | "session_page", revision: number) => ({
      type: kind, sessionId: "durable", state: "idle", phase: "completed",
      phaseSince: 100, epoch: revision - 1, afterRevision: revision - 1, headRevision: revision,
      nextRevision: null,
      actions: [{ revision, actionId: `action-${revision}`, kind: "turn", at: 100 }],
      usage: [], toolWallMs: 0,
    });
    let turns = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: upgradeWebSocket,
      websocket: {
        message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
          const frame = readFrame.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
          if (frame.type === "session_read") {
            ws.send(JSON.stringify(sessionPage("session_snapshot", 2)));
            return;
          }
          turns += 1;
          ws.send(JSON.stringify({ type: "receipt", status: "accepted" }));
          ws.send(JSON.stringify({
            type: "session_bound",
            result: { status: "executed", handle: { messageId: `input-${turns}`, target: "durable" }, delivery: { kind: "session" } },
          }));
          if (turns === 1) {
            ws.send(JSON.stringify({ type: "message", messageId: "msg-1", text: "answer 1" }));
            return;
          }
          // The terminal page describes the PREVIOUS completion and lands
          // before this turn's own answer frame.
          ws.send(JSON.stringify(sessionPage("session_page", 3)));
          ws.send(JSON.stringify({ type: "message", messageId: "msg-2", text: "answer 2" }));
        },
      },
    });
    servers.push(server);
    const transport = createGatewayChatTransport({ id: testId, url: `ws://127.0.0.1:${server.port}` });
    const epochs: number[] = [];
    const stop = transport.subscribeSession((page) => epochs.push(page.epoch));

    const first = await collect(await send(transport, [userMessage("one")]));
    expect(
      first.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["answer 1"]);
    await transport.readSession("durable");

    const second = await collect(await send(transport, [userMessage("two")]));
    stop();
    expect(epochs).toEqual([1, 2]);
    expect(second.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(
      second.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["answer 2"]);
  });

  test("binds only from session_bound; receipts and pre-blocked results never bind", async () => {
    ControlledSocket.instances.length = 0;
    const bound: [string, string][] = [];
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
      onSessionBound: (chatId, sessionId) => bound.push([chatId, sessionId]),
    });
    const sending = send(transport, [userMessage("bind")]);
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const stream = await sending;

    controlled.receive(JSON.stringify({ type: "receipt", status: "accepted" }));
    // The retired result-bearing receipt is no longer a valid frame: ignored.
    controlled.receive(JSON.stringify({
      type: "receipt", status: "accepted",
      result: { status: "executed", handle: { messageId: "in-0", target: "legacy" }, delivery: { kind: "session" } },
    }));
    // A pre-blocked admission carries no durable target.
    controlled.receive(JSON.stringify({
      type: "session_bound", result: { status: "blocked_pre", reasonCode: "policy" },
    }));
    expect(bound).toEqual([]);

    controlled.receive(JSON.stringify({
      type: "session_bound",
      result: { status: "executed", handle: { messageId: "in-1", target: "durable-1" }, delivery: { kind: "session" } },
    }));
    expect(bound).toEqual([["chat-1", "durable-1"]]);
    controlled.respond("done");
    await collect(stream);
  });

  test("the SDK reduces the chunks into one assistant message", async () => {
    const { url } = serveWire([
      [
        { type: "receipt", status: "accepted" },
        { type: "message", messageId: "sdk-message", text: "two files touched" },
      ],
    ]);
    let ids = 0;
    const chat = new Chat<UIMessage>({
      transport: createGatewayChatTransport({ id: testId, url }),
      generateId: () => {
        ids += 1;
        return `id-${ids}`;
      },
    });

    await chat.sendMessage({ text: "what changed?" });

    expect(chat.status).toBe("ready");
    const last = chat.lastMessage;
    if (last === undefined) throw new Error("no message was reduced");
    expect(last.role).toBe("assistant");
    expect(last.parts.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
      "two files touched",
    );
  });
});

describe("session reads over the gateway socket", () => {
  const head = {
    sessionId: "durable",
    state: "idle",
    phase: "completed",
    phaseSince: 100,
    epoch: 2,
    headRevision: 3,
    usage: [],
    toolWallMs: 0,
  } as const;

  test("a page pointing at a next revision is followed with a cursor until the read drains", async () => {
    const cursors: (SessionRead.Cursor | undefined)[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: upgradeWebSocket,
      websocket: {
        message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
          const request = SessionRead.Request.parse(JSON.parse(String(raw)));
          cursors.push(request.cursor);
          ws.send(
            JSON.stringify(
              request.cursor === undefined
                ? {
                    ...head,
                    type: "session_snapshot",
                    afterRevision: 0,
                    nextRevision: 2,
                    actions: [
                      { revision: 1, actionId: "action-1", kind: "turn", at: 100 },
                      { revision: 2, actionId: "action-2", kind: "turn", at: 101 },
                    ],
                  }
                : {
                    ...head,
                    type: "session_page",
                    afterRevision: request.cursor.revision,
                    nextRevision: null,
                    actions: [{ revision: 3, actionId: "action-3", kind: "turn", at: 102 }],
                  },
            ),
          );
        },
      },
    });
    servers.push(server);
    const transport = createGatewayChatTransport({ id: testId, url: `ws://127.0.0.1:${server.port}` });
    const seen: (number | null)[] = [];
    const stop = transport.subscribeSession((page) => seen.push(page.nextRevision));

    const final = await transport.readSession("durable");
    stop();

    expect(cursors).toEqual([undefined, { revision: 2, epoch: 2 }]);
    expect(seen).toEqual([2, null]);
    expect(final).toMatchObject({ type: "session_page", afterRevision: 2, nextRevision: null });
    expect(final.actions.map((action) => action.revision)).toEqual([3]);
  });

  test("a session-scoped error frame rejects that session's pending read", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: upgradeWebSocket,
      websocket: {
        message(ws: ServerWebSocket<undefined>) {
          ws.send(JSON.stringify({ type: "error", sessionId: "durable", reason: "session evicted" }));
        },
      },
    });
    servers.push(server);
    const transport = createGatewayChatTransport({ id: testId, url: `ws://127.0.0.1:${server.port}` });

    await expect(transport.readSession("durable")).rejects.toThrow("session evicted");
  });

  test("a socket that closes mid-read rejects the pending read", async () => {
    const readSeen = signal();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: upgradeWebSocket,
      websocket: {
        message() {
          readSeen.resolve();
        },
      },
    });
    servers.push(server);
    const transport = createGatewayChatTransport({ id: testId, url: `ws://127.0.0.1:${server.port}` });

    const read = transport.readSession("durable");
    const rejection = read.then(
      () => {
        throw new Error("read unexpectedly resolved");
      },
      (error: Error) => error,
    );
    await readSeen.promise;
    server.stop(true);

    expect((await rejection).message).toBe("gateway socket closed unexpectedly");
  });

  test("a send failure during a session read rejects instead of hanging", async () => {
    class ReadFailingSocket extends ControlledSocket {
      override send(data: string): void {
        if (data.includes("session_read")) throw new Error("session read send failed");
        super.send(data);
      }
    }
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
    id: testId,
      url: "ws://controlled",
      WebSocketImpl: ReadFailingSocket,
    });

    const read = transport.readSession("durable");
    const rejection = read.then(
      () => {
        throw new Error("read unexpectedly resolved");
      },
      (error: Error) => error,
    );
    const socket = ControlledSocket.instances[0];
    if (socket === undefined) throw new Error("socket was not constructed");
    socket.open();

    expect((await rejection).message).toBe("session read send failed");
  });

  /**
   * A server that holds every inbound `session_read` until the test releases
   * it, so a second read can be admitted while the first is still in flight.
   */
  function serveHeldRead() {
    let heldSocket: ServerWebSocket<undefined> | undefined;
    let requests = 0;
    const readSeen = signal();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: upgradeWebSocket,
      websocket: {
        message(ws: ServerWebSocket<undefined>) {
          requests += 1;
          heldSocket = ws;
          readSeen.resolve();
        },
      },
    });
    servers.push(server);
    return {
      readSeen: readSeen.promise,
      requests: () => requests,
      respond(page: typeof terminalPage) {
        if (heldSocket === undefined) throw new Error("no read was received");
        heldSocket.send(JSON.stringify(page));
      },
      stop() {
        server.stop(true);
      },
      url: `ws://127.0.0.1:${server.port}`,
    };
  }

  const terminalPage = {
    ...head,
    type: "session_snapshot",
    afterRevision: 0,
    nextRevision: null,
    actions: [{ revision: 3, actionId: "action-3", kind: "turn", at: 102 }],
  } as const;

  test("two concurrent identical reads coalesce onto one request and both resolve", async () => {
    const wire = serveHeldRead();
    const transport = createGatewayChatTransport({ id: testId, url: wire.url });

    const first = transport.readSession("durable");
    await wire.readSeen;
    const second = transport.readSession("durable");
    wire.respond(terminalPage);

    const [firstPage, secondPage] = await Promise.all([first, second]);
    expect(firstPage).toMatchObject({ type: "session_snapshot", nextRevision: null });
    expect(secondPage).toEqual(firstPage);
    expect(wire.requests()).toBe(1);
  });

  test("a differing-cursor second read is rejected while the first still resolves", async () => {
    const wire = serveHeldRead();
    const transport = createGatewayChatTransport({ id: testId, url: wire.url });

    const first = transport.readSession("durable");
    await wire.readSeen;
    const superseding = transport.readSession("durable", { revision: 2, epoch: 2 }).then(
      () => {
        throw new Error("superseding read unexpectedly resolved");
      },
      (error: Error) => error,
    );
    const rejection = await superseding;
    expect(rejection).toBeInstanceOf(SessionReadSupersessionError);
    expect(rejection.message).toBe(
      'a session read for "durable" is already in flight with a different cursor',
    );

    wire.respond(terminalPage);
    expect(await first).toMatchObject({ type: "session_snapshot", nextRevision: null });
    expect(wire.requests()).toBe(1);
  });

  test("a close drains every coalesced waiter", async () => {
    const wire = serveHeldRead();
    const transport = createGatewayChatTransport({ id: testId, url: wire.url });

    const asRejection = (read: Promise<SessionRead.Page>) =>
      read.then(
        () => {
          throw new Error("read unexpectedly resolved");
        },
        (error: Error) => error,
      );
    const first = asRejection(transport.readSession("durable"));
    await wire.readSeen;
    const second = asRejection(transport.readSession("durable"));
    wire.stop();

    expect((await first).message).toBe("gateway socket closed unexpectedly");
    expect((await second).message).toBe("gateway socket closed unexpectedly");
  });
});
