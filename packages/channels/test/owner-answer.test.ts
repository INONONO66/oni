import { adoptLedgerFence, ledger, resetLedger } from "./helpers/ledger";
import { sessionTree } from "../../agent/test/store/helpers/session-tree";
import { channelRequests } from "./helpers/channel-requests";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runEffect } from "./helpers/effect";
import { Effect } from "effect";
import { decodeChannelFailure } from "../src/errors";
import { testWebSocketId, websocketCallbacks } from "./helpers/websocket-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@oni/agent";
import { TEST_APPROVAL_POLICY } from "../../agent/test/helpers/approval-policy";
const decideRequestTransition = Core.decideRequestTransition;
const requestBindingDigest = Core.requestBindingDigest;
import { Gateway, PlainValueSchema, canonicalDigest, type Channel, type SessionTransition, } from "@oni/protocol";
import { WebSocketHandler } from "../src/websocket";
import { makeRouter } from "./router/_router-fixture";
import { originalAction, requestPort } from "./helpers/requests";
import { requestFixture } from "./helpers/request-record";
import { bounded } from "./helpers/bounded";

const credential = "owner-frame-secret";
const sender = { kind: "external", surface: "ws", externalId: "owner-console" } as const;
const principal = {
  kind: "owner",
  principalId: "owner",
  evidenceId: "owner-auth-evidence",
} as const;
let directory: string;
let dbPath: string;
let at: number;
const stops: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "owner-answer-"));
  dbPath = join(directory, "ledger.sqlite");
  at = 10;
  resetLedger({ catalog: join(directory, "catalog.sqlite"), sessions: dbPath });
});

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  resetLedger();
  rmSync(directory, { recursive: true, force: true });
});

async function approval() {
  originalAction("protected-call", "owner-session", { person: "alice", trustTier: "trusted" });
  const row = ledger().kernel.row("owner-session");
  const generation = ledger().kernel.latestGenerationFor(row.id);
  const request = requestFixture({
    requestId: "protected-call",
    sessionId: row.id,
    callId: "protected-call",
    mode: "approval",
    parsedInput: { person: "alice", trustTier: "trusted" },
    inputHash: canonicalDigest({ person: "alice", trustTier: "trusted" }),
    effectHash: canonicalDigest({}),
    generation: row.policyGeneration,
    toolsGeneration: row.toolsGeneration,
    toolsHash: generation.toolsHash,
    systemHash: row.systemHash,
    expectedResponders: ["owner"],
    domainRevisions: { persons: 1 },
    correlation: {},
  });
  request.bindingDigest = requestBindingDigest(request);
  const fence = adoptLedgerFence(row.id, "fixture");
  const decision = decideRequestTransition(
    {
      version: 1,
      inputId: "open",
      sessionId: row.id,
      at: 2,
      expectedRevision: row.revision,
      authority: { owner: "fixture", fence },
      payload: { kind: "request.open", request },
    },
    { row: ledger().kernel.row(row.id), invocation: ledger().kernel.actionById(request.requestId), inputRecord: ledger().kernel.requestInputById(row.id, "open") },
    TEST_APPROVAL_POLICY.recentOpen,
  );
  expect(decision.resolution).toBe("opened");
  await runEffect(ledger().kernel.commit({
    sessionId: row.id,
    owner: "fixture",
    fence,
    now: 2,
    expectedRevision: row.revision,
    actions: [...decision.actions],
    state: row.state,
  }));
  return request;
}

function envelope(request: SessionTransition.Request, decision: "approve" | "refuse" = "approve") {
  return { kind: "request_answer", inputId: "answer-1", request, decision, credential } as const;
}

function wireAnswer(
  request: SessionTransition.Request,
  decision: "approve" | "refuse" = "approve",
) {
  return Gateway.RequestAnswer.omit({ kind: true }).strip().parse(envelope(request, decision));
}

function router(
  options: {
    principal?: SessionTransition.Principal;
    domainRevision?: number;
    authenticated?: (who: Gateway.IngestSender, proof: string, requestId: string) => void;
  } = {},
) {
  return makeRouter({
    now: () => at,
    requests: channelRequests(requestPort(() => at, undefined, {
      requestDomainRevisions: () => ({ persons: options.domainRevision ?? 1 }),
    })),
    authenticateAnswer: (who: Gateway.IngestSender & { kind: "external" }, proof: string, requestId: string) => Effect.try({
      try: () => {
        options.authenticated?.(who, proof, requestId);
        if (proof !== credential) throw new Error(`invalid secret: ${proof}`);
        return options.principal ?? principal;
      },
      catch: decodeChannelFailure("fixture.authenticate_answer"),
    }),
    prepare() {
      throw new Error("typed answer reached message preparation");
    },
    run() {
      throw new Error("typed answer reached message recording");
    },
  });
}

async function event(target: EventTarget, name: string): Promise<Event> {
  const received = Promise.withResolvers<Event>();
  const listener = (value: Event) => received.resolve(value);
  target.addEventListener(name, listener, { once: true });
  try {
    return await bounded(received.promise);
  } finally {
    target.removeEventListener(name, listener);
  }
}

async function connect(
  gateway: ReturnType<typeof router>,
  messages: Channel.InboundMessage[] = [],
  logs: string[] = [],
) {
  const handler = new WebSocketHandler(
    (message: Channel.InboundMessage) => Effect.sync(() => {
      messages.push(message);
    }),
    <T>(_event: import("@oni/protocol").BusEvent.Descriptor<T>, data: T) => {
      logs.push(JSON.stringify(data));
    },
    {
      token: "upgrade-secret",
      now: () => at,
      id: testWebSocketId(),
      onRequestAnswer: (who: Gateway.IngestSender, answer: Gateway.RequestAnswer) => gateway.ingest(who, answer),
    },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request: Request, instance: Bun.Server<import("../src/websocket").WsConnectionData>) => handler.handleUpgrade(request, instance),
    websocket: websocketCallbacks(handler),
  });
  stops.push(() => server.stop(true));
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?actor=owner-console`, [
    "auth",
    "upgrade-secret",
  ]);
  stops.push(() => {
    socket.terminate();
  });
  const opened = event(socket, "open");
  await opened;
  expect(socket.protocol).toBe("auth");
  return { socket, server };
}

async function frame(socket: WebSocket, value: object) {
  const received = event(socket, "message");
  socket.send(JSON.stringify(value));
  const message = await received;
  if (!(message instanceof MessageEvent)) throw new Error("expected WebSocket message");
  return PlainValueSchema.parse(JSON.parse(message.data));
}

test.each([
  "approve",
  "refuse",
] as const)("real authenticated WebSocket %s reaches only canonical request actions", async (decision: "approve" | "refuse") => {
  const request = await approval();
  const authenticated: object[] = [];
  const gateway = router({
    authenticated: (who: { kind: "external"; surface: string; externalId: string; } | { kind: "session"; id: string; }, proof: string, requestId: string) => {
      authenticated.push({ who, proof, requestId });
    },
  });
  const messages: Channel.InboundMessage[] = [];
  const logs: string[] = [];
  const { socket } = await connect(gateway, messages, logs);
  const answer = wireAnswer(request, decision);
  const receipt = await frame(socket, { type: "request_answer", ...answer });
  expect(receipt).toMatchObject({
    type: "receipt",
    inputId: answer.inputId,
    result: {
      status: "executed",
      handle: { messageId: answer.inputId, target: request.sessionId },
    },
  });
  expect(authenticated).toEqual([{ who: sender, proof: credential, requestId: request.requestId }]);
  expect(ledger().kernel.requestById(request.requestId)?.state).toBe(
    decision === "approve" ? "resolved" : "refused",
  );
  const actions = sessionTree(request.sessionId, ledger().sessions.actions);
  expect(actions.find((action: import("@oni/protocol").LedgerAction.Node) => action.kind === "request" && (action.effect.value as { phase?: string }).phase === "answered")?.effect.value).toMatchObject({
    answer: { receivedAt: 10, principal, decision, inputHash: request.inputHash },
  });
  expect(JSON.stringify(actions)).not.toContain(credential);
  expect(JSON.stringify(actions)).not.toContain("credential");
  expect(logs.join()).not.toContain(credential);
  expect(messages).toEqual([]);
  expect(ledger().kernel.pendingMessages(request.sessionId)).toEqual([]);
});

test("same typed answer survives SQLite and gateway restart with a fresh owner clock", async () => {
  const request = await approval();
  const first = await connect(router());
  const answer = wireAnswer(request);
  const wire = { type: "request_answer", ...answer };
  expect(await frame(first.socket, wire)).toMatchObject({ result: { status: "executed" } });
  const before = sessionTree(request.sessionId, ledger().sessions.actions);
  await first.server.stop(true);
  resetLedger({ catalog: join(directory, "catalog.sqlite"), sessions: dbPath });
  at = 20;
  const second = await connect(router());
  expect(await frame(second.socket, wire)).toMatchObject({ result: { status: "executed" } });
  expect(sessionTree(request.sessionId, ledger().sessions.actions)).toEqual(before);
  expect(
    sessionTree(request.sessionId, ledger().sessions.actions).filter(
      (action: import("@oni/protocol").LedgerAction.Node) => action.id === `${request.requestId}:resolution`,
    ),
  ).toHaveLength(1);
});

test("wrong frame credential is refused without recording or leaking it", async () => {
  const request = await approval();
  const before = sessionTree(request.sessionId, ledger().sessions.actions);
  const { socket } = await connect(router());
  const answer = wireAnswer(request);
  const result = await frame(socket, {
    type: "request_answer",
    ...answer,
    credential: "wrong-secret",
  });
  expect(result).toMatchObject({
    result: { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" },
  });
  expect(JSON.stringify(result)).not.toContain("wrong-secret");
  expect(sessionTree(request.sessionId, ledger().sessions.actions)).toEqual(before);
});

test("session sender, malformed input, missing authenticator, and non-Owner evidence fail closed", async () => {
  const request = await approval();
  let calls = 0;
  const gateway = router({
    authenticated: () => {
      calls++;
    },
  });
  expect(
    await runEffect(gateway.ingest({ kind: "session", id: request.sessionId }, envelope(request))),
  ).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.session_sender",
  });
  expect(await runEffect(gateway.ingest(sender, { ...envelope(request), inputId: "" }))).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.invalid",
  });
  expect(calls).toBe(0);
  expect(await runEffect(makeRouter().ingest(sender, envelope(request)))).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.unauthenticated",
  });
  expect(
    await runEffect(router({ principal: { ...principal, kind: "actor" } }).ingest(sender, envelope(request))),
  ).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.unauthenticated",
  });
  expect(ledger().kernel.requestById(request.requestId)?.state).toBe("open");
});

test.each([
  "inputHash",
  "bindingDigest",
  "generation",
  "domainRevisions",
] as const)("canonical kernel rejects altered %s", async (field: "inputHash" | "generation" | "domainRevisions" | "bindingDigest") => {
  const request = await approval();
  const altered = {
    ...request,
    ...(field === "generation"
      ? { generation: 999 }
      : field === "domainRevisions"
        ? { domainRevisions: { persons: 999 } }
        : { [field]: "altered" }),
  };
  expect(await runEffect(router().ingest(sender, envelope(altered)))).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.rejected",
  });
  expect(ledger().kernel.requestById(request.requestId)?.state).toBe("open");
});

test("current domain revision and captured owner receipt time remain kernel gates", async () => {
  const request = await approval();
  expect(await runEffect(router({ domainRevision: 2 }).ingest(sender, envelope(request)))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.rejected",
  });
  at = request.deadline;
  expect(await runEffect(router().ingest(sender, { ...envelope(request), inputId: "late" }))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.late_unknown",
  });
  expect(ledger().kernel.pendingMessages(request.sessionId)).toEqual([]);
});

test("Owner authentication finishing at the deadline cannot approve into the past", async () => {
  const request = await approval();
  const gateway = router({
    authenticated: () => {
      at = request.deadline;
    },
  });
  expect(await runEffect(gateway.ingest(sender, envelope(request)))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.late_unknown",
  });
  expect(ledger().kernel.requestById(request.requestId)?.state).toBe("expired");
});

test("an authenticated Owner answer cannot bypass the absolute blacklist", async () => {
  const request = await approval();
  ledger().stores.blacklist.put({ id: "blocked-surface", kind: "channel", value: "ws", createdBy: "owner" });
  const before = sessionTree(request.sessionId, ledger().sessions.actions);
  expect(await runEffect(router().ingest(sender, envelope(request)))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.blacklisted",
  });
  expect(sessionTree(request.sessionId, ledger().sessions.actions)).toEqual(before);
});

test("plain text preserves stable driver event ID and cannot enter Owner authentication", async () => {
  const request = await approval();
  const messages: Channel.InboundMessage[] = [];
  let calls = 0;
  const { socket } = await connect(
    router({
      authenticated: () => {
        calls++;
      },
    }),
    messages,
  );
  expect(await frame(socket, { text: "approve", eventId: "text-redelivery" })).toEqual({
    type: "receipt",
    status: "accepted",
  });
  expect(messages).toMatchObject([
    {
      sender,
      facts: {
        eventId: "text-redelivery",
        render: "approve",
        payload: { websocket: { authenticated: true } },
      },
    },
  ]);
  expect(calls).toBe(0);
  expect(ledger().kernel.requestById(request.requestId)?.state).toBe("open");
});

test("typed frames reject missing input identity and untrusted principal fields", async () => {
  const request = await approval();
  const { socket } = await connect(router());
  const answer = wireAnswer(request);
  for (const value of [
    { ...answer, inputId: undefined },
    { ...answer, inputId: undefined, text: "must not become a plain message" },
    { ...answer, principal },
  ]) {
    expect(await frame(socket, { type: "request_answer", ...value })).toEqual({
      type: "error",
      reason: "InvalidInbound",
    });
  }
  expect(ledger().kernel.requestById(request.requestId)?.state).toBe("open");
});

test("actual WebSocket upgrade rejects the wrong transport token", async () => {
  await approval();
  const { server } = await connect(router());
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["auth", "wrong-upgrade"]);
  const failed = event(socket, "error");
  await failed;
  expect(socket.readyState).not.toBe(WebSocket.OPEN);
});

test("typed public schema rejects caller-supplied trust or receipt time", async () => {
  const request = await approval();
  expect(Gateway.RequestAnswer.safeParse(envelope(request)).success).toBe(true);
  for (const extra of [{ trustTier: "owner" }, { receivedAt: 0 }, { principal }]) {
    expect(Gateway.RequestAnswer.safeParse({ ...envelope(request), ...extra }).success).toBe(false);
  }
});
