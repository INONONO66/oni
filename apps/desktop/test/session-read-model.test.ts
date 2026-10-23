import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { SessionFork, SessionRead } from "@oni/protocol";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { attentionKind } from "../src/renderer/attention/order";
import { createGatewayChatTransport } from "../src/renderer/chat/gateway-transport";
import { GatewayUnavailableError } from "../src/renderer/errors";
import {
  fetchGatewayEndpoint,
  queryKeys,
  sessionReadModel,
  sessionReadOptions,
  subscribeSessionReads,
} from "../src/renderer/state/queries";
import { adoptForkedSession, bindDurableSession } from "../src/renderer/state/session-actions";
import {
  activeTab, consoleStore, createSession, INITIAL_CLIENT_STATE, openTab, setDraft,
} from "../src/renderer/state/store";
import { upgradeWebSocket } from "./helpers/chat-server";
import { testId } from "./helpers/platform";

const cleanups: (() => void)[] = [];
beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

test("gateway endpoint reads the bridge and stays null outside Electron", async () => {
  expect(await fetchGatewayEndpoint()).toBeNull();
  const desktop = {
    gateway: () => Promise.resolve({ url: "ws://localhost:3000/ws" }),
    closeWindow: () => undefined,
    onShellCommand: () => () => undefined,
  };
  Object.defineProperty(globalThis, "desktop", { configurable: true, value: desktop });
  try {
    expect(await fetchGatewayEndpoint()).toEqual({ url: "ws://localhost:3000/ws" });
  } finally {
    Reflect.deleteProperty(globalThis, "desktop");
  }
});

function page(phase: SessionRead.Page["phase"], revision: number, epoch = 2): SessionRead.Page {
  return SessionRead.Page.parse({
    type: "session_page", sessionId: "durable", epoch, state: phase === "running" ? "running" : "idle",
    phase, phaseSince: 100, afterRevision: revision - 1, headRevision: revision, nextRevision: null,
    actions: [{ revision, actionId: `action-${revision}`, kind: "turn", at: 100 }],
    usage: [], toolWallMs: 0,
  });
}

function serveReads() {
  const requests: SessionRead.Request[] = [];
  let connection: ServerWebSocket<undefined> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: upgradeWebSocket,
    websocket: {
      open: (socket: ServerWebSocket<undefined>) => { connection = socket; },
      message(socket: ServerWebSocket<undefined>, raw) {
        const frame = z.record(z.string(), z.json()).parse(JSON.parse(String(raw)));
        if (frame.type !== "session_read") {
          socket.send(JSON.stringify({ type: "receipt", status: "accepted" }));
          socket.send(JSON.stringify({
            type: "session_bound",
            result: { status: "executed", handle: { messageId: "input", target: "durable" }, delivery: { kind: "session" } },
          }));
          return;
        }
        const request = SessionRead.Request.parse(frame);
        requests.push(request);
        socket.send(JSON.stringify(request.cursor?.epoch === 1
          ? { type: "session_gap", sessionId: "durable", epoch: 2, headRevision: 3, oldestRevision: 0 }
          : { ...page("running", 3), type: request.cursor === undefined ? "session_snapshot" : "session_page" }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    requests,
    url: `ws://127.0.0.1:${server.port}`,
    send(value: SessionRead.Page | { type: "message"; messageId: string; text: string }) {
      if (connection === undefined) throw new Error("socket not open");
      connection.send(JSON.stringify(value));
    },
  };
}

test("a session read without a configured gateway refuses with the named class", async () => {
  const client = new QueryClient();
  cleanups.push(() => client.clear());
  await expect(client.fetchQuery(sessionReadOptions(client, null, "durable"))).rejects.toThrow(
    GatewayUnavailableError,
  );
});

test("session_read repairs a stale cursor with a fresh snapshot on the existing transport", async () => {
  const wire = serveReads();
  const transport = createGatewayChatTransport({ id: testId, url: wire.url });
  const repaired = await transport.readSession("durable", { revision: 1, epoch: 1 });
  expect(wire.requests.map((request) => request.cursor)).toEqual([{ revision: 1, epoch: 1 }, undefined]);
  expect(repaired).toMatchObject({ type: "session_snapshot", epoch: 2, headRevision: 3 });
});

test("durable query pages own phase and attention while tabs and drafts stay local", async () => {
  const wire = serveReads();
  const client = new QueryClient();
  cleanups.push(() => client.clear());
  const localId = createSession(10);
  openTab({ kind: "session", sessionId: localId });
  setDraft(localId, "unsent");
  const localState = consoleStore.state;
  let bound: (() => void) | undefined;
  const binding = new Promise<void>((resolve) => { bound = resolve; });
  const transport = createGatewayChatTransport({
    id: testId,
    url: wire.url,
    onSessionBound: (id, durableId) => { bindDurableSession(id, durableId); bound?.(); },
  });
  const stream = await transport.sendMessages({
    trigger: "submit-message", chatId: localId, messageId: undefined, abortSignal: undefined,
    messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "hello" }] }],
  });
  await binding;
  cleanups.push(subscribeSessionReads(client, transport));
  const local = consoleStore.state.sessions[0];
  if (local === undefined) throw new Error("local session missing");
  expect(local.durableSessionId).toBe("durable");
  expect("phase" in local).toBe(false);
  expect(sessionReadModel(local, undefined).phase).toBeNull();
  const running = await client.fetchQuery(sessionReadOptions(client, transport, "durable"));
  expect(sessionReadModel(local, running).phase).toBe("running");
  expect(attentionKind(sessionReadModel(local, running), 100)).toBe("watch");

  const received = new Promise<void>((resolve) => {
    const stop = transport.subscribeSession((next) => {
      if (next.headRevision === 4) { stop(); resolve(); }
    });
  });
  wire.send(page("completed", 4));
  await received;
  // The terminal page updates the read model only (review r1 finding 1): the
  // chat stream settles on its own message frame, never on a session phase.
  wire.send({ type: "message", messageId: "reply-1", text: "done" });
  const reader = stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value.type);
  }
  expect(chunks).toEqual(["start", "text-start", "text-delta", "text-end", "finish"]);
  const delayed = new Promise<void>((resolve) => {
    const stop = transport.subscribeSession((next) => {
      if (next.headRevision === 3) { stop(); resolve(); }
    });
  });
  wire.send(page("running", 3));
  await delayed;
  const durable = client.getQueryData<SessionRead.Page>(queryKeys.session("durable"));
  expect(sessionReadModel(local, durable).phase).toBe("completed");
  expect(attentionKind(sessionReadModel(local, durable), 100)).toBe("rest");
  expect(consoleStore.state.tabs).toBe(localState.tabs);
  expect(consoleStore.state.drafts).toBe(localState.drafts);
  expect(consoleStore.state.activeTabId).toBe(localState.activeTabId);
});

test("an empty same-epoch same-head continuation keeps the authoritative activity", async () => {
  // Review r1 finding 2: a refetch that finds no new actions must not erase
  // the cached page's last-activity timestamp with the local fallback.
  const requests: SessionRead.Request[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: upgradeWebSocket,
    websocket: {
      message(socket: ServerWebSocket<undefined>, raw) {
        const request = SessionRead.Request.parse(JSON.parse(String(raw)));
        requests.push(request);
        const head = {
          sessionId: "durable", state: "idle" as const, phase: "completed" as const,
          phaseSince: 900, epoch: 2, headRevision: 1, nextRevision: null, usage: [], toolWallMs: 0,
        };
        socket.send(JSON.stringify(request.cursor === undefined
          ? { ...head, type: "session_snapshot", afterRevision: 0,
              actions: [{ revision: 1, actionId: "action-1", kind: "turn", at: 900 }] }
          : { ...head, type: "session_page", afterRevision: request.cursor.revision, actions: [] }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const client = new QueryClient();
  cleanups.push(() => client.clear());
  const transport = createGatewayChatTransport({ id: testId, url: `ws://127.0.0.1:${server.port}` });
  const localId = createSession(10);
  bindDurableSession(localId, "durable");
  const local = consoleStore.state.sessions[0];
  if (local === undefined) throw new Error("local session missing");

  const first = await client.fetchQuery(sessionReadOptions(client, transport, "durable"));
  expect(sessionReadModel(local, first).lastActivityAt).toBe(900);

  const second = await client.fetchQuery(sessionReadOptions(client, transport, "durable"));
  expect(requests.map((request) => request.cursor)).toEqual([undefined, { revision: 1, epoch: 2 }]);
  expect(second.actions.map((action) => action.at)).toEqual([900]);
  expect(sessionReadModel(local, second).lastActivityAt).toBe(900);
});

test("forkSession resolves the gateway's typed answer and the read model exposes anchor and ancestry", async () => {
  const pin = { session: "parent", anchor: "parent-turn", parentSeq: 3, parentHead: "parent-latest", copied: 4 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: upgradeWebSocket,
    websocket: {
      message(socket: ServerWebSocket<undefined>, raw) {
        const frame = z.record(z.string(), z.json()).parse(JSON.parse(String(raw)));
        if (frame.type === "session_read") {
          socket.send(JSON.stringify({
            type: "session_snapshot", sessionId: "durable", state: "idle", phase: "completed",
            phaseSince: 100, epoch: 1, afterRevision: 0, headRevision: 3, nextRevision: null,
            actions: [
              { revision: 1, actionId: "prompt-1", kind: "prompt", at: 100, forkAnchor: "prompt-1" },
              { revision: 2, actionId: "tool-1", kind: "tool", at: 110 },
              { revision: 3, actionId: "turn-1", kind: "turn", at: 120, forkAnchor: "turn-1" },
            ],
            usage: [], toolWallMs: 0,
            ancestry: { parentId: "parent", forkedFrom: pin, aside: "aside text" },
          }));
          return;
        }
        const request = SessionFork.Request.parse(frame);
        socket.send(JSON.stringify(request.at === "bad"
          ? { type: "session_fork_refused", sessionId: request.sessionId,
              reason: "anchor_not_found", detail: "no such anchor" }
          : { type: "session_forked", sessionId: request.childId ?? "minted",
              parentId: request.sessionId, forkedFrom: { ...pin, anchor: request.at }, head: "child-head" }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const transport = createGatewayChatTransport({ id: testId, url: `ws://127.0.0.1:${server.port}` });

  const localId = createSession(5);
  bindDurableSession(localId, "durable");
  const local = consoleStore.state.sessions[0];
  if (local === undefined) throw new Error("local session missing");
  const page = await transport.readSession("durable");
  const model = sessionReadModel(local, page);
  // The NEWEST boundary row's anchor is where the desktop fork would cut.
  expect(model.latestForkAnchor).toBe("turn-1");
  expect(model.ancestry).toEqual({ parentId: "parent", forkedFrom: pin, aside: "aside text" });
  expect(model.forkAside).toBe("aside text");

  const refused = await transport.forkSession({ sessionId: "durable", at: "bad" });
  expect(refused).toMatchObject({ type: "session_fork_refused", reason: "anchor_not_found" });
  const forked = await transport.forkSession({ sessionId: "durable", at: "turn-1", childId: "child" });
  expect(forked).toMatchObject({
    type: "session_forked",
    sessionId: "child",
    parentId: "durable",
    forkedFrom: { ...pin, anchor: "turn-1" },
  });
  // Adoption gives the child its own bound local handle and an open tab.
  const childLocalId = adoptForkedSession("child", "Fork of durable", 9);
  const child = consoleStore.state.sessions.find((entry) => entry.id === childLocalId);
  expect(child?.durableSessionId).toBe("child");
  expect(child?.title).toBe("Fork of durable");
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: childLocalId });
});
