import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Machine } from "@oni/protocol";
import { createMachineHost } from "../src/host";
import { createMemoryGenerationStore } from "../src/generation-store";
import { MachineRefusalError } from "../src/errors";
import { acquire, run } from "./ipc/helpers/effects";
import { connectIpcClient } from "./ipc/helpers/native";
import { socketPath } from "./helpers/socket-path";
import { refusingToolPort } from "./helpers/native";
import { captureError, within } from "./ipc/helpers/signal";

const machineId = "client-one";
const pin = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const request = { sessionId: "session-one", requestId: "permission-one", tool: "write", description: "change file" };
const cursor = { sessionId: request.sessionId, generation: 1, byteOffset: 0, recordHash: "a".repeat(64) };
const offer = {
  machineId, peer: { kind: "client", contractVersion: 3 }, daemonVersion: "test",
  platform: "darwin-arm64", offeredCapabilities: ["agent.session"], offeredAt: 2,
} satisfies Machine.Offer;

async function fixture(
  allowed: boolean,
  decideAgentPermission?: (id: string, request: Machine.AgentPermissionRequest) => Effect.Effect<Machine.AgentPermissionDecision>,
  deadline = 30_000,
  onDetach?: () => void,
) {
  const path = socketPath();
  const { value: host, close } = await acquire(createMachineHost({
    listen: { unix: path }, id: () => crypto.randomUUID(), dispatcherBound: 16,
    enrollment: () => ({ machineId, name: "client", publicKey: pin, enrolledAt: 1, allowedCapabilities: allowed ? ["agent.session"] : ["fs.read"] }),
    generations: createMemoryGenerationStore(), events: { publish: (event) => {
      if (event === Machine.Events.Detached) onDetach?.();
    } },
    now: () => 3, callTool: refusingToolPort, decideAgentPermission,
    agentPermissionDeadlineMs: deadline,
  }));
  return {
    host, path,
    async close() { await run(host.close()); await close(); },
  };
}

test("session methods route to the current admitted client and validate cursor generations", async () => {
  const state = await fixture(true);
  const methods: string[] = [];
  const client = await connectIpcClient(state.path, {
    onRequest(method, _params, respond) {
      methods.push(method);
      switch (method) {
        case Machine.WireMethod.AgentSessionList:
          respond({ status: "ok", sessions: [], truncated: false }); break;
        case Machine.WireMethod.AgentSessionOpen:
          respond({ status: "ok", cursor }); break;
        case Machine.WireMethod.AgentSessionTail:
          respond({ status: "ok", records: [], cursor, hasMore: false }); break;
        case Machine.WireMethod.AgentSessionSend:
        case Machine.WireMethod.AgentSessionStop:
          respond({ status: "ok" }); break;
        default: throw new Error(`unexpected method: ${method}`);
      }
    },
  });
  try {
    expect(await client.call(Machine.WireMethod.Attach, offer)).toMatchObject({ status: "attached", generation: 1 });
    const session = state.host.get(machineId).agentSession;
    if (session === undefined) throw new Error("attached host did not provide agentSession");
    expect(await run(session.list({ project: "/project" }))).toEqual({ status: "ok", sessions: [], truncated: false });
    expect(await run(session.open({ project: "/project", cli: "pi" }))).toEqual({ status: "ok", cursor });
    expect(await run(session.tail({ cursor }))).toEqual({ status: "ok", records: [], cursor, hasMore: false });
    expect(await run(session.send({ sessionId: request.sessionId, text: "hello" }))).toEqual({ status: "ok" });
    expect(await run(session.stop({ sessionId: request.sessionId }))).toEqual({ status: "ok" });
    expect(methods).toEqual([
      Machine.WireMethod.AgentSessionList, Machine.WireMethod.AgentSessionOpen,
      Machine.WireMethod.AgentSessionTail, Machine.WireMethod.AgentSessionSend, Machine.WireMethod.AgentSessionStop,
    ]);
    const error = await captureError(run(session.tail({ cursor: { ...cursor, generation: 2 } })));
    expect(error).toMatchObject({ _tag: "MachineRefusalError", reason: "stale_generation" });
    expect(methods).toHaveLength(5);
    await client.close();
    expect(await captureError(run(session.list({ project: "/project" })))).toMatchObject({
      _tag: "MachineRefusalError", reason: "disconnected",
    });
  } finally {
    await client.close();
    await state.close();
  }
});

test("a session reply from a superseded attachment is refused on the same connection", async () => {
  const entered = Promise.withResolvers<void>();
  let answerOpen: ((value: Machine.AgentSessionOpenResult) => void) | undefined;
  const state = await fixture(true);
  const client = await connectIpcClient(state.path, {
    onRequest(method, _params, respond) {
      if (method !== Machine.WireMethod.AgentSessionOpen) throw new Error(`unexpected method: ${method}`);
      answerOpen = respond;
      entered.resolve();
    },
  });
  try {
    expect(await client.call(Machine.WireMethod.Attach, offer)).toMatchObject({ status: "attached", generation: 1 });
    const session = state.host.get(machineId).agentSession;
    if (session === undefined) throw new Error("attached host did not provide agentSession");
    const pending = captureError(run(session.open({ project: "/project", cli: "pi" })));
    await within(entered.promise, "session open entry");
    expect(await client.call(Machine.WireMethod.Attach, offer))
      .toMatchObject({ status: "attached", generation: 2 });
    if (answerOpen === undefined) throw new Error("open request was not received");
    answerOpen({ status: "ok", cursor });
    expect(await within(pending, "superseded session reply")).toMatchObject({
      _tag: "MachineRefusalError", reason: "stale_generation",
    });
  } finally {
    await client.close();
    await state.close();
  }
});

test("an attachment without the negotiated capability cannot route or request permission", async () => {
  let decisions = 0;
  const state = await fixture(false, () => {
    decisions += 1;
    return Effect.succeed({ status: "allowed", sessionId: request.sessionId, requestId: request.requestId });
  });
  const client = await connectIpcClient(state.path);
  try {
    expect(await client.call(Machine.WireMethod.Attach, offer)).toMatchObject({ status: "attached", effectiveCapabilities: [] });
    const session = state.host.get(machineId).agentSession;
    if (session === undefined) throw new Error("attached host did not provide agentSession");
    expect(await captureError(run(session.list({ project: "/project" })))).toBeInstanceOf(MachineRefusalError);
    expect(await client.call(Machine.WireMethod.AgentPermission, request)).toEqual({
      status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason: "denied",
    });
    expect(decisions).toBe(0);
  } finally {
    await client.close();
    await state.close();
  }
});

test("a daemon claiming the client capability cannot route a session or a permission", async () => {
  let decisions = 0;
  const state = await fixture(true, () => {
    decisions += 1;
    return Effect.succeed({ status: "allowed", sessionId: request.sessionId, requestId: request.requestId });
  });
  const client = await connectIpcClient(state.path);
  try {
    await client.call(Machine.WireMethod.Attach, { ...offer, peer: { kind: "daemon", contractVersion: 3 } });
    const session = state.host.get(machineId).agentSession;
    if (session === undefined) throw new Error("attached host did not provide agentSession");
    expect(await captureError(run(session.list({ project: "/project" })))).toBeInstanceOf(MachineRefusalError);
    expect(await client.call(Machine.WireMethod.AgentPermission, request)).toEqual({
      status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason: "denied",
    });
    expect(decisions).toBe(0);
  } finally {
    await client.close();
    await state.close();
  }
});

test("permission decisions are correlated and mismatched answers deny", async () => {
  const entered = Promise.withResolvers<void>();
  const state = await fixture(true, (_id, input) => {
    expect(input).toEqual(request);
    entered.resolve();
    return Effect.succeed({ status: "allowed", sessionId: input.sessionId, requestId: "wrong" });
  });
  const client = await connectIpcClient(state.path);
  try {
    await client.call(Machine.WireMethod.Attach, offer);
    const answer = client.call(Machine.WireMethod.AgentPermission, request);
    await within(entered.promise, "permission port entry");
    expect(await answer).toEqual({ status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason: "denied" });
  } finally {
    await client.close();
    await state.close();
  }
});

test("an admitted permission relays an explicit verdict and rejects concurrent duplicate ids", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Machine.AgentPermissionDecision>();
  let calls = 0;
  const state = await fixture(true, () => {
    calls += 1;
    entered.resolve();
    return Effect.promise(() => release.promise);
  });
  const client = await connectIpcClient(state.path);
  try {
    await client.call(Machine.WireMethod.Attach, offer);
    const first = client.call(Machine.WireMethod.AgentPermission, request);
    await within(entered.promise, "permission port entry");
    expect(await client.call(Machine.WireMethod.AgentPermission, request)).toEqual({
      status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason: "denied",
    });
    expect(calls).toBe(1);
    release.resolve({ status: "allowed", sessionId: request.sessionId, requestId: request.requestId });
    expect(await first).toEqual({ status: "allowed", sessionId: request.sessionId, requestId: request.requestId });
  } finally {
    await client.close();
    await state.close();
  }
});

test("a host without a permission port denies even an admitted client", async () => {
  const state = await fixture(true);
  const client = await connectIpcClient(state.path);
  try {
    await client.call(Machine.WireMethod.Attach, offer);
    expect(await client.call(Machine.WireMethod.AgentPermission, request)).toEqual({
      status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason: "denied",
    });
  } finally {
    await client.close();
    await state.close();
  }
});

test("disconnect ends a pending decision and excludes its late port answer", async () => {
  const entered = Promise.withResolvers<void>();
  const detached = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Machine.AgentPermissionDecision>();
  const state = await fixture(true, () => {
    entered.resolve();
    return Effect.promise(() => late.promise);
  }, 30_000, () => detached.resolve());
  const client = await connectIpcClient(state.path);
  try {
    await client.call(Machine.WireMethod.Attach, offer);
    const answer = captureError(client.call(Machine.WireMethod.AgentPermission, request));
    await within(entered.promise, "permission port entry");
    await client.close();
    expect((await within(answer, "connection loss")).name).toBe("IpcConnectionError");
    await within(detached.promise, "attachment detachment");
    late.resolve({ status: "allowed", sessionId: request.sessionId, requestId: request.requestId });
    expect(state.host.list()).toEqual([]);
  } finally {
    await client.close();
    await state.close();
  }
});

test("deadline denies a pending permission and excludes its late answer", async () => {
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Machine.AgentPermissionDecision>();
  const state = await fixture(true, (_id, input) => {
    entered.resolve();
    return input.requestId === request.requestId ? Effect.promise(() => late.promise) :
      Effect.succeed({ status: "allowed", sessionId: input.sessionId, requestId: input.requestId });
  }, 20);
  const client = await connectIpcClient(state.path);
  try {
    await client.call(Machine.WireMethod.Attach, offer);
    const answer = client.call(Machine.WireMethod.AgentPermission, request);
    await within(entered.promise, "permission port entry");
    expect(await within(answer, "deadline decision")).toEqual({
      status: "refused", sessionId: request.sessionId, requestId: request.requestId, reason: "timeout",
    });
    late.resolve({ status: "allowed", sessionId: request.sessionId, requestId: request.requestId });
    expect(await client.call(Machine.WireMethod.AgentPermission, { ...request, requestId: "next" })).toEqual({
      status: "allowed", sessionId: request.sessionId, requestId: "next",
    });
  } finally {
    await client.close();
    await state.close();
  }
});
