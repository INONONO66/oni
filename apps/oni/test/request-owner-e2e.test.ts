import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type { SessionTransition } from "@oni/protocol";
import {
  ORIGINAL_CALL,
  OWNER_TOKEN,
  PERSON,
  type OwnerProcessEvent,
  type OwnerSnapshot,
} from "./helpers/request-owner-process";
import { closeSocket, nextFrame, openSocket } from "./helpers/ws";

function child(catalogPath: string, sessionsDir: string, at: number, recovering = false) {
  const events: OwnerProcessEvent[] = [];
  const listeners = new Set<(event: OwnerProcessEvent) => void>();
  const process = Bun.spawn(
    [
      execPath,
      join(import.meta.dir, "helpers/request-owner-process.ts"),
      catalogPath,
      sessionsDir,
      String(at),
      recovering ? "recover" : "initial",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: OwnerProcessEvent) {
        events.push(message);
        for (const listener of listeners) listener(message);
      },
    },
  );
  const output = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const next = <T extends OwnerProcessEvent["type"]>(type: T, id?: string) => {
    type Event = Extract<OwnerProcessEvent, { type: T }>;
    return new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(receive);
        const evidence = events.map((event) =>
          event.type === "error"
            ? event
            : {
                type: event.type,
                person: event.snapshot.person,
                modelCalls: event.snapshot.modelCalls,
                requests: event.snapshot.requests.map((request) => ({
                  requestId: request.requestId,
                  state: request.state,
                  toolsHash: request.toolsHash,
                })),
                terminal: event.snapshot.sessions.flatMap((session) => session.actions).at(-1)
                  ?.effect.value,
              },
        );
        reject(
          new Error(`process ${process.pid} missing ${type}; events=${JSON.stringify(evidence)}`),
        );
      }, 5000);
      function receive(event: OwnerProcessEvent) {
        if (event.type === "error") {
          clearTimeout(timer);
          listeners.delete(receive);
          reject(new Error(event.error));
        } else if (
          event.type === type &&
          (id === undefined || ("id" in event && event.id === id))
        ) {
          clearTimeout(timer);
          listeners.delete(receive);
          resolve(event as Event);
        }
      }
      listeners.add(receive);
      for (const event of events) receive(event);
    });
  };
  return {
    pid: process.pid,
    next,
    async inspect(type: "snapshot" | "drift" = "snapshot") {
      const id = crypto.randomUUID();
      const received = next("snapshot", id);
      process.send({ type, id });
      return (await received).snapshot;
    },
    async crash() {
      process.kill("SIGKILL");
      await process.exited;
      expect(process.signalCode).toBe("SIGKILL");
      // The detached mclient inherits these pipes and survives a parent SIGKILL;
      // EOF is not a signal that the crashed app process has exited.
    },
    async close() {
      if (process.exitCode !== null || process.signalCode !== null) {
        return;
      }
      const started = events.some((event) => event.type === "ready");
      const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
      try {
        if (started) process.send({ type: "stop" });
        else process.kill("SIGKILL");
        const exitCode = await process.exited;
        const logs = await output;
        if (started) expect(exitCode, logs.join("\n")).toBe(0);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function requestOf(snapshot: OwnerSnapshot) {
  const request = snapshot.requests.find((item) => item.callId === ORIGINAL_CALL.id);
  if (request === undefined)
    throw new Error(`missing original request: ${JSON.stringify(snapshot)}`);
  return request;
}

function noLegacy(snapshot: OwnerSnapshot) {
  expect(snapshot.tables).not.toContain("wait");
  expect(snapshot.tables).not.toContain("approval");
  const actions = snapshot.sessions.flatMap((session) => session.actions);
  expect(actions.filter((action) => /^(wait|approval)\./.test(action.kind))).toEqual([]);
}

async function answer(
  socket: WebSocket,
  request: SessionTransition.Request,
  inputId: string,
  credential = OWNER_TOKEN,
) {
  const receipt = nextFrame(
    socket,
    (frame) => frame.type === "receipt" && frame.inputId === inputId,
  );
  socket.send(
    JSON.stringify({ type: "request_answer", inputId, request, decision: "approve", credential }),
  );
  return (await receipt).result;
}

test("authenticated Owner executes the captured Person invocation once across SIGKILL and two restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "request-owner-e2e-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const processes: ReturnType<typeof child>[] = [];
  const sockets: WebSocket[] = [];
  const boot = (at: number, recovering = false) => {
    const process = child(catalogPath, sessionsDir, at, recovering);
    processes.push(process);
    return process;
  };
  const connect = async (port: number) => {
    const socket = await openSocket(`ws://127.0.0.1:${port}/ws?actor=owner`, ["auth", OWNER_TOKEN]);
    sockets.push(socket);
    return socket;
  };
  try {
    const first = boot(Date.now());
    const initial = await first.next("ready");
    const socket = await connect(initial.port);
    const opened = first.next("opened");
    socket.send(
      JSON.stringify({ text: "Declare the protected Person.", eventId: "original-owner-prompt" }),
    );
    const before = (await opened).snapshot;
    const request = requestOf(before);
    expect(request.state).toBe("open");
    expect(request.parsedInput).toEqual(ORIGINAL_CALL.input);
    expect(before.person).toBeNull();
    expect(before.modelCalls).toBe(1);
    const captured = before.sessions.find((session) => session.row.id === request.sessionId);
    if (captured === undefined || captured.row.fenceOwner === null)
      throw new Error("missing crash lease");
    expect(captured.actions.find((action) => action.id === request.requestId)?.kind).toBe("tool");
    expect(request.toolsHash).toBe(captured.generation.toolsHash);
    noLegacy(before);

    expect(await answer(socket, request, "wrong-token", "not-the-owner")).toMatchObject({
      status: "blocked_pre",
      reasonCode: "request_answer.unauthenticated",
    });
    expect(
      await answer(socket, { ...request, inputHash: "altered" }, "altered-hash"),
    ).toMatchObject({
      status: "blocked_pre",
      reasonCode: "request_answer.rejected",
    });
    const rejected = await first.inspect();
    expect(rejected.person).toBeNull();
    expect(requestOf(rejected).state).toBe("open");
    // W5.2: the catalog also lists the boot-created gateway-ingress session,
    // so select the request's session by id instead of assuming order.
    expect(
      rejected.sessions.find((session) => session.row.id === request.sessionId)?.actions,
    ).toEqual(captured.actions);

    await first.crash();
    // W5.2: leases are fence-based, not time-based; restart wall-clock time
    // only needs to precede the request deadline.
    const restartedAt = Date.now() + 1;
    expect(restartedAt).toBeLessThan(request.deadline);
    const second = boot(restartedAt, true);
    expect(second.pid).not.toBe(first.pid);
    const suspended = await second.next("ready");
    expect(requestOf(suspended.snapshot)).toEqual(request);
    expect(suspended.snapshot.person).toBeNull();
    expect(suspended.snapshot.modelCalls).toBe(0);
    expect(
      suspended.snapshot.sessions.find((session) => session.row.id === request.sessionId)
        ?.generation,
    ).toEqual(captured.generation);
    noLegacy(suspended.snapshot);
    const recovered = await second.next("ready");
    expect(requestOf(recovered.snapshot)).toEqual(request);
    expect(recovered.snapshot.person).toBeNull();
    expect(recovered.snapshot.modelCalls).toBe(0);
    expect(
      recovered.snapshot.sessions.find((session) => session.row.id === request.sessionId)
        ?.generation,
    ).toEqual(captured.generation);
    const ownerSocket = await connect(recovered.port);
    const applied = second.next("applied");
    const settled = second.next("settled");
    const receipt = answer(ownerSocket, request, "exact-owner-answer");
    const [result, mutation] = await Promise.all([receipt, applied, settled]);
    expect(result).toMatchObject({ status: "executed" });
    expect(mutation.snapshot.person).toMatchObject({ ...PERSON, revision: 0 });
    expect(mutation.snapshot.modelCalls).toBe(0);
    expect(
      mutation.snapshot.sessions
        .flatMap((session) => session.actions)
        .filter((action) => action.parentId === request.requestId && action.kind === "tool"),
    ).toMatchObject([
      { id: `${request.requestId}:application`, effect: { value: { phase: "application" } } },
      { effect: { value: { phase: "result", terminal: "executed" } } },
    ]);
    expect(await answer(ownerSocket, request, "second-owner-decision")).toMatchObject({
      status: "blocked_pre",
      reasonCode: "request_answer.rejected",
    });
    const committed = await second.inspect();
    expect(committed.person).toMatchObject({ ...PERSON, revision: 0 });
    expect(requestOf(committed).state).toBe("resolved");
    const actions = committed.sessions.flatMap((session) => session.actions);
    expect(
      actions.filter((action) => action.id === `${request.requestId}:application`),
    ).toHaveLength(1);
    expect(
      actions.filter((action) => action.id === `${request.requestId}:resolution`),
    ).toHaveLength(1);
    noLegacy(committed);

    await second.crash();
    const third = boot(restartedAt + 60_000, true);
    const redelivered = await third.next("ready");
    expect(third.pid).not.toBe(second.pid);
    expect(redelivered.snapshot.person).toEqual(committed.person);
    const duplicateSocket = await connect(redelivered.port);
    expect(await answer(duplicateSocket, request, "exact-owner-answer")).toMatchObject({
      status: "executed",
    });
    const duplicate = await third.inspect();
    expect(duplicate.person).toEqual(committed.person);
    expect(duplicate.modelCalls).toBe(0);
    expect(duplicate.sessions.flatMap((session) => session.actions)).toEqual(actions);
    noLegacy(duplicate);
  } finally {
    try {
      await Promise.all(sockets.map((socket) => closeSocket(socket)));
    } finally {
      try {
        await Promise.all(processes.map((process) => process.close()));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}, 20_000);

test("real Owner socket cannot apply an original Person invocation against a changed domain revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "request-owner-stale-"));
  const process = child(join(directory, "catalog.sqlite"), join(directory, "sessions"), Date.now());
  let socket: WebSocket | undefined;
  try {
    const ready = await process.next("ready");
    socket = await openSocket(`ws://127.0.0.1:${ready.port}/ws?actor=owner`, ["auth", OWNER_TOKEN]);
    const opened = process.next("opened");
    socket.send(
      JSON.stringify({ text: "Declare protected Person.", eventId: "stale-owner-prompt" }),
    );
    const before = (await opened).snapshot;
    const request = requestOf(before);
    const drifted = await process.inspect("drift");
    expect(drifted.person).toMatchObject({ trustTier: "observer", revision: 0 });
    expect(await answer(socket, request, "stale-domain")).toMatchObject({
      status: "blocked_pre",
      reasonCode: "request_answer.rejected",
    });
    const after = await process.inspect();
    expect(after.person).toEqual(drifted.person);
    expect(requestOf(after).state).toBe("open");
    // W5.2: select the request's session by id (catalog also lists gateway-ingress).
    const sessionActions = (snapshot: OwnerSnapshot) =>
      snapshot.sessions.find((session) => session.row.id === request.sessionId)?.actions ?? [];
    const previous = sessionActions(drifted);
    expect(sessionActions(after).slice(0, previous.length)).toEqual(previous);
    expect(sessionActions(after).slice(previous.length)).toMatchObject([
      { kind: "request", effect: { value: { resolution: "rejected" } } },
    ]);
    expect(after.modelCalls).toBe(1);
    noLegacy(after);
  } finally {
    try {
      if (socket !== undefined) await closeSocket(socket);
    } finally {
      try {
        await process.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}, 15_000);
