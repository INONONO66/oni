import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createChannelStores, WebSocketHandler, type WsConnection } from "@oni/channels";
import { channelHistoryLookup, channelHistoryWire } from "../src/composition/channel-history";
import type { ChannelHistoryLookup } from "../src/composition/channel-history";
import { channelHistory, parseChannelHistoryArgs } from "../src/cli/channel-history";
import { createChannelSupervisor, type DesiredChannelRow } from "../src/bundles/provision/supervisor";
import type { ProviderHistoryRoute } from "@oni/channels";
import { gatewayRuntime, webSocketCallbacks, channelStoreSource } from "../src/gateway";
import { composedHolder } from "./helpers/bundle-fixture";
import { Bus } from "./helpers/bus";
import { testPlane } from "./helpers/ledger";
import { testIds } from "./helpers/test-entropy";
import { runEffect } from "./helpers/effect";
import { startOni } from "../src/index";
import { testMachinesPlane } from "./helpers/self-machine";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const owner = { authenticated: true, caller: "owner" } as const;
const page = {
  messages: [{
    chatId: "chat-1", messageId: "msg-2", senderId: "user-1", outgoing: false,
    text: "hello", timestampMs: 123, attachments: [],
  }],
  before: "msg-2",
};
const request = JSON.stringify({
  type: "channel_history", requestId: "req-1", instanceId: "kakaotalk:owner",
  chatId: "chat-1", limit: 2,
});

function historySupervisor(rows: () => readonly DesiredChannelRow[], historyRoutes: Map<string, ProviderHistoryRoute>) {
  return createChannelSupervisor({
    desired: () => ({ source: "declared", rows: rows(), statuses: [] }),
    build: (component) => component.build(async () => undefined),
    grant: () => () => undefined,
    deliveryRoutes: new Map(), typingRoutes: new Map(), webhookHandlers: new Map(),
    historyRoutes, traceId: () => "trace",
  });
}

describe("channel history read boundary", () => {
  test("non-Telegram route returns a page without ingress", async () => {
    const queried: string[] = [];
    const lookup: ChannelHistoryLookup = (instanceId) => ({
      status: "ready",
      history: async (query) => {
        queried.push(`${instanceId}:${query.chatId}:${query.limit}`);
        return { status: "ok", page };
      },
    });
    const effect = channelHistoryWire(request, owner, lookup);
    expect(effect).toBeDefined();
    if (effect === undefined) throw new Error("history was not intercepted");
    expect(await runEffect(effect)).toEqual({
      type: "channel_history_page", requestId: "req-1", instanceId: "kakaotalk:owner", page,
    });
    expect(queried).toEqual(["kakaotalk:owner:chat-1:2"]);
  });

  test("two history pages use an exclusive opaque cursor without reading media", async () => {
    const calls: string[] = [];
    const base = page.messages[0];
    if (base === undefined) throw new Error("history fixture is empty");
    const lookup: ChannelHistoryLookup = () => ({
      status: "ready",
      history: async (query) => {
        calls.push(query.before ?? "start");
        return {
          status: "ok",
          page: query.before === undefined
            ? { messages: [{ ...base, messageId: "second", timestampMs: 100 },
              { ...base, messageId: "first", timestampMs: 100 }],
              before: "first" }
            : { messages: [{ ...base, messageId: "older", timestampMs: 90 }] },
        };
      },
    });
    const first = channelHistoryWire(request, owner, lookup);
    const second = channelHistoryWire(JSON.stringify({
      type: "channel_history", requestId: "req-2", instanceId: "kakaotalk:owner",
      chatId: "chat-1", limit: 2, before: "first",
    }), owner, lookup);
    if (first === undefined || second === undefined) throw new Error("history was not intercepted");
    const initial = await runEffect(first);
    const older = await runEffect(second);
    expect(initial).toMatchObject({ type: "channel_history_page", page: { before: "first" } });
    expect(older).toMatchObject({ type: "channel_history_page", page: { messages: [{ messageId: "older" }] } });
    expect(calls).toEqual(["start", "first"]);
    if (initial.type !== "channel_history_page" || older.type !== "channel_history_page")
      throw new Error("history was refused");
    expect(new Set([...initial.page.messages, ...older.page.messages].map((item) => item.messageId)).size).toBe(3);
  });

  test("peer and tokenless Owner refuse before any lookup", async () => {
    let lookups = 0;
    const lookup: ChannelHistoryLookup = () => {
      lookups += 1;
      return { status: "refused", reason: "owner_not_ready" };
    };
    for (const access of [{ authenticated: false, caller: "owner" } as const,
      { authenticated: true, caller: "session:peer" } as const]) {
      const effect = channelHistoryWire(request, access, lookup);
      if (effect === undefined) throw new Error("history was not intercepted");
      expect(await runEffect(effect)).toMatchObject({
        type: "channel_history_refused", requestId: "req-1", reason: "owner_auth_required",
      });
    }
    expect(lookups).toBe(0);
  });

  test("malformed history with chat text is intercepted and correlated", async () => {
    const effect = channelHistoryWire(JSON.stringify({
      type: "channel_history", requestId: "req-2", instanceId: "telegram:owner",
      chatId: "chat-1", limit: 101, text: "please ingest",
    }), owner, () => { throw new Error("lookup must not run"); });
    if (effect === undefined) throw new Error("history was not intercepted");
    expect(await runEffect(effect)).toMatchObject({
      type: "channel_history_refused", requestId: "req-2", reason: "invalid_request",
    });
    const oversize = channelHistoryWire(JSON.stringify({
      type: "channel_history", requestId: "req-3", instanceId: "telegram:owner",
      chatId: "x".repeat(513), limit: 1, text: "not a prompt",
    }), owner, () => { throw new Error("lookup must not run"); });
    if (oversize === undefined) throw new Error("oversize history was not intercepted");
    expect(await runEffect(oversize)).toMatchObject({
      type: "channel_history_refused", requestId: "req-3", reason: "invalid_request",
    });
  });

  test("absent instance and provider refusal remain typed", async () => {
    const missing = channelHistoryWire(request, owner, () => ({ status: "refused", reason: "owner_not_ready" }));
    const noCapability = channelHistoryWire(request, owner, () => ({ status: "refused", reason: "history_unavailable" }));
    const revoked = channelHistoryWire(request, owner, () => ({
      status: "ready", history: async () => ({ status: "refused", reason: "session_lost" }),
    }));
    if (missing === undefined || noCapability === undefined || revoked === undefined) throw new Error("history was not intercepted");
    expect(await runEffect(missing)).toMatchObject({ reason: "owner_not_ready" });
    expect(await runEffect(noCapability)).toMatchObject({ reason: "history_unavailable" });
    expect(await runEffect(revoked)).toMatchObject({ reason: "session_lost" });
  });
});

describe("oni channel history", () => {
  test("validates ids, cursors and bounds", () => {
    expect(parseChannelHistoryArgs(["telegram:owner", "chat"])).toEqual({
      instanceId: "telegram:owner", chatId: "chat", limit: 50,
    });
    for (const args of [
      [], ["telegram:owner", ""], ["telegram:owner", "chat", "--limit", "0"],
      ["telegram:owner", "chat", "--limit", "101"],
      ["telegram:owner", "chat", "--limit", "1.5"],
      ["telegram:owner", "chat", "--before", ""],
      ["telegram:owner", "chat", "--api-hash", "secret"],
    ]) expect(() => parseChannelHistoryArgs(args)).toThrow();
  });

  test("prints only page JSON or typed refusal", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };
    const deps = { id: () => "req-1", read: async () => ({
      type: "channel_history_page" as const, requestId: "req-1", instanceId: "telegram:owner", page,
    }) };
    expect(await channelHistory(["telegram:owner", "chat-1"], deps, io)).toBe(0);
    expect(stdout).toEqual([JSON.stringify(page)]);
    expect(stderr).toEqual([]);
    expect(await channelHistory(["telegram:owner", "chat-1"], {
      ...deps, read: async () => ({
        type: "channel_history_refused" as const, requestId: "req-1",
        reason: "history_unavailable" as const, detail: "Unavailable",
      }),
    }, io)).toBe(1);
    expect(stderr).toEqual(["channel_history_refused (history_unavailable): Unavailable"]);
    expect(await channelHistory(["telegram:owner", "chat-1"], {
      ...deps, read: async () => { throw new Error("socket lost"); },
    }, io)).toBe(1);
    expect(stderr.at(-1)).toBe("socket lost");
  });
});

test("supervisor publishes history only after start and removes it before close", async () => {
  const routes = new Map<string, ProviderHistoryRoute>();
  const observed: string[] = [];
  const history: ProviderHistoryRoute = async () => ({ status: "ok", page });
  let rows = [{
    instanceId: "channel:kakaotalk:owner", key: "first",
    defaultTier: "assigned_worker" as const,
    component: {
      id: "kakaotalk" as const, identity: "owner" as const, listens: false,
      build: () => ({
        surface: {
          id: "kakaotalk:owner", config: {},
          onMessage: () => undefined,
          start: async () => { observed.push(`start:${routes.size}`); },
          stop: async () => { observed.push(`stop:${routes.size}`); },
        },
        historyRoute: history,
      }),
    },
  }];
  const supervisor = historySupervisor(() => rows, routes);
  await supervisor.reconcile();
  expect(observed).toEqual(["start:0"]);
  expect(routes.get("kakaotalk:owner")).toBe(history);
  rows = [];
  await supervisor.reconcile();
  expect(observed).toEqual(["start:0", "stop:0"]);
  expect(routes.size).toBe(0);
});

test("an Owner withdrawal revokes mounted history, reports withdrawn and keeps its typed cause", async () => {
  const routes = new Map<string, ProviderHistoryRoute>();
  const listeners: ((reason: "login_action_required" | "session_lost") => void)[] = [];
  const history: ProviderHistoryRoute = async () => ({ status: "ok", page });
  const first = {
    instanceId: "channel:telegram:owner", key: "first",
    defaultTier: "assigned_worker" as const,
    component: {
      id: "telegram" as const, identity: "owner" as const, listens: false,
      build: () => ({
        surface: {
          id: "telegram:owner", config: {},
          onMessage: () => undefined, start: async () => undefined, stop: async () => undefined,
        },
        historyRoute: history,
        onWithdrawn: (listener: (reason: "login_action_required" | "session_lost") => void) => { listeners.push(listener); },
      }),
    },
  };
  let rows = [first];
  const supervisor = historySupervisor(() => rows, routes);
  const lookup = channelHistoryLookup(routes, supervisor);
  await supervisor.reconcile();
  expect(lookup("telegram:owner")).toEqual({ status: "ready", history });
  listeners[0]?.("login_action_required");
  listeners[0]?.("session_lost");
  expect(routes.size).toBe(0);
  const withdrawn = { id: "channel:telegram:owner", surface: "telegram:owner", state: "withdrawn" as const, detail: "login_action_required" };
  expect(supervisor.status()).toEqual([withdrawn]);
  expect(lookup("telegram:owner")).toEqual({ status: "refused", reason: "login_action_required" });
  expect(await supervisor.reconcile()).toEqual([withdrawn]);
  rows = [{ ...first, key: "second" }];
  await supervisor.reconcile();
  expect(lookup("telegram:owner")).toEqual({ status: "ready", history });
  // The unwound first mount's late notice cannot revoke its replacement.
  listeners[0]?.("session_lost");
  expect(routes.get("telegram:owner")).toBe(history);
  rows = [];
  await supervisor.reconcile();
  expect(lookup("telegram:owner")).toEqual({ status: "refused", reason: "owner_not_ready" });
});

test("gateway history interception answers an Owner while peers and malformed frames never ingress", async () => {
  const plane = testPlane();
  const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
  try {
    plane.stores.channelGrants.put({
      id: "ws-owner", surface: "ws", kind: "trusted_channel",
      defaultTier: "owner", createdBy: "owner",
    });
    const stores = createChannelStores(channelStoreSource(plane, () => 0));
    const handler = new WebSocketHandler(() => Effect.void, Bus.publish, { now: () => 0, id: testIds("history-gateway") });
    const frames: string[] = [];
    let lookedUp = 0;
    const lookup: ChannelHistoryLookup = (instanceId) => {
      lookedUp += 1;
      expect(instanceId).toBe("kakaotalk:owner");
      return { status: "ready", history: async () => ({ status: "ok", page }) };
    };
    const callbacks = webSocketCallbacks(runtime, handler, Bus, undefined, undefined, {
      respond: () => Effect.die(new Error("history must not enter automation")),
      stores,
    }, undefined, undefined, undefined, lookup);
    const ownerSocket: WsConnection = {
      data: { surfaceKey: "ws::dm:owner", authenticated: true, externalId: "owner" },
      send: (frame) => { frames.push(frame); },
    };
    await callbacks.callbacks.message(ownerSocket, request);
    expect(JSON.parse(frames.pop() ?? "")).toMatchObject({
      type: "channel_history_page", requestId: "req-1", instanceId: "kakaotalk:owner",
    });
    const peerSocket: WsConnection = { ...ownerSocket, data: { ...ownerSocket.data, authenticated: false } };
    await callbacks.callbacks.message(peerSocket, request);
    expect(JSON.parse(frames.pop() ?? "")).toMatchObject({ reason: "owner_auth_required" });
    await callbacks.callbacks.message(ownerSocket, JSON.stringify({
      type: "channel_history", requestId: "bad", instanceId: "kakaotalk:owner",
      chatId: "chat-1", limit: 101, text: "not a prompt",
    }));
    expect(JSON.parse(frames.pop() ?? "")).toMatchObject({ reason: "invalid_request" });
    expect(lookedUp).toBe(1);
    expect(plane.read.sessions.list()).toEqual([]);
    callbacks.callbacks.close(ownerSocket);
    callbacks.callbacks.close(peerSocket);
  } finally {
    plane.close();
    await runtime.dispose();
  }
});

test("real app socket refuses absent history capability before session ingress", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oni-history-app-"));
  const app = await startOni({
    config: {
      catalogPath: join(directory, "catalog.sqlite"),
      sessionsDir: join(directory, "sessions"),
      machineGenerationsPath: join(directory, "machines", "generations.json"),
      host: "127.0.0.1", wsPort: 0, wsToken: "history-test-token",
      kek: { kind: "locked", reason: "no vault in this fixture" },
      machines: testMachinesPlane(),
      model: { provider: "fake", id: "history-app", apiKey: "test-key" },
    },
  });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "history-test-token"]);
    const answered = Promise.withResolvers<string>();
    socket.addEventListener("message", (event) => answered.resolve(String(event.data)), { once: true });
    const opened = Promise.withResolvers<void>();
    socket.addEventListener("open", () => opened.resolve(), { once: true });
    await opened.promise;
    socket.send(JSON.stringify({
      type: "channel_history", requestId: "app-request",
      instanceId: "telegram:owner", chatId: "chat", limit: 1,
    }));
    expect(JSON.parse(await answered.promise)).toMatchObject({
      type: "channel_history_refused", requestId: "app-request", reason: "owner_not_ready",
    });
    socket.close();
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
