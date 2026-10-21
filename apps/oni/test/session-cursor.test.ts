import { expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { Bus, newTraceId } from "./helpers/bus";
import { L0Observation } from "@oni/protocol";
import { readSessionCursor } from "../src/gateway";
import { planeOf } from "./helpers/ledger";
import { bounded } from "./helpers/protected-dispatch";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { closeSocket, nextFrame } from "./helpers/ws";
import { nextResidentTurn } from "./helpers/resident-turn";
import { assistantMessage } from "./helpers/assistant-message";

const suite = residentSuite();

/** Boot a resident app whose model answers every turn with "done", plus its ledger plane. */
async function bootDoneApp(prefix: string, wsToken: string) {
  const app = await suite.boot({
    config: suite.config(prefix, { wsToken }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "done" }));
        return { type: "stop" as const };
      }),
    },
  });
  return { app, plane: await planeOf(app.runtime) };
}

test("a reconnect replays only committed revisions beyond its cursor", async () => {
  const committed = Promise.withResolvers<string>();
  const { app, plane } = await bootDoneApp("session-cursor-", "cursor-token");
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind === "turn") committed.resolve(event.sessionId);
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "cursor-token"]);
  const terminal = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "first" }));
  const sessionId = await bounded(committed.promise);
  const kernel = plane.openKernel(sessionId);
  const first = readSessionCursor(kernel, { type: "session_read", sessionId, limit: 4 });
  expect(first.type).toBe("session_snapshot");
  if (first.type === "session_gap") throw new Error("fresh session returned a gap");
  expect(first.actions.length).toBeLessThanOrEqual(4);
  const cursor = { revision: first.actions.at(-1)?.revision ?? 0, epoch: first.epoch };
  await terminal;
  await closeSocket(socket);
  const reconnect = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "cursor-token"]);

  const replayFrame = nextFrame(reconnect, (frame) => frame.type === "session_page");
  reconnect.send(JSON.stringify({ type: "session_read", sessionId, limit: 4, cursor }));
  const replay = await replayFrame;
  expect(replay.afterRevision).toBe(cursor.revision);
  expect(Array.isArray(replay.actions)).toBe(true);
  const actions = replay.actions;
  if (!Array.isArray(actions)) throw new Error("invalid replay actions");
  expect(actions.every((action) => typeof action === "object" &&
    action !== null && !Array.isArray(action) && typeof action.revision === "number" &&
    action.revision > cursor.revision)).toBe(true);

  const gapFrame = nextFrame(reconnect, (frame) => frame.type === "session_gap");
  reconnect.send(JSON.stringify({
    type: "session_read",
    sessionId,
    limit: 4,
    cursor: { revision: cursor.revision, epoch: cursor.epoch + 1 },
  }));
  expect(await gapFrame).toMatchObject({ type: "session_gap", oldestRevision: 0, sessionId });

  const repair = nextFrame(reconnect, (frame) => frame.type === "session_snapshot");
  reconnect.send(JSON.stringify({ type: "session_read", sessionId, limit: 256 }));
  expect(await repair).toMatchObject({
    type: "session_snapshot", sessionId, state: "idle", phase: "completed",
    headRevision: kernel.row(sessionId).revision, nextRevision: null,
  });
  await closeSocket(reconnect);
  const staleReconnect = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "cursor-token"]);
  const stale = nextFrame(staleReconnect, (frame) => frame.type === "session_gap");
  staleReconnect.send(JSON.stringify({
    type: "session_read", sessionId, limit: 256,
    cursor: { revision: kernel.row(sessionId).revision + 1, epoch: kernel.row(sessionId).fence },
  }));
  expect(await stale).toMatchObject({ type: "session_gap", sessionId, headRevision: kernel.row(sessionId).revision });
  const repaired = nextFrame(staleReconnect, (frame) => frame.type === "session_snapshot");
  staleReconnect.send(JSON.stringify({ type: "session_read", sessionId, limit: 256 }));
  expect(await repaired).toMatchObject({ type: "session_snapshot", phase: "completed", nextRevision: null });

  const refused = nextFrame(staleReconnect, (frame) => frame.type === "error");
  staleReconnect.send(JSON.stringify({ type: "session_read", sessionId: "missing-session", limit: 4 }));
  expect(await refused).toMatchObject({ type: "error", reason: "session_not_found" });
});

test("a registered reader receives authoritative commits after its captured head", async () => {
  const { app, plane } = await bootDoneApp("session-reader-", "reader-token");
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "reader-token"]);
  const order: string[] = [];
  socket.addEventListener("message", (event) => {
    const frame = z.object({ type: z.string() }).loose().safeParse(JSON.parse(String(event.data)));
    if (frame.success && (frame.data.type === "receipt" || frame.data.type === "session_bound")) {
      order.push(frame.data.type);
    }
  });
  const accepted = nextFrame(socket, (frame) => frame.type === "receipt");
  const boundFrame = nextFrame(socket, (frame) => frame.type === "session_bound");
  const firstTerminal = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "first" }));
  // Frozen frame: the accepted receipt is exactly its base two keys …
  expect(await accepted).toEqual({ type: "receipt", status: "accepted" });
  // … and the durable binding follows on the same socket as session_bound.
  const bound = await boundFrame;
  expect(order).toEqual(["receipt", "session_bound"]);
  const target = bound.result;
  if (target === null || typeof target !== "object" || Array.isArray(target) ||
      target.status !== "executed" || target.handle === null ||
      typeof target.handle !== "object" || Array.isArray(target.handle) ||
      typeof target.handle.target !== "string") throw new Error("missing durable session target");
  const sessionId = target.handle.target;
  await firstTerminal;
  const snapshot = nextFrame(socket, (frame) => frame.type === "session_snapshot");
  socket.send(JSON.stringify({ type: "session_read", sessionId, limit: 256 }));
  const initial = await snapshot;
  const headRevision = initial.headRevision;
  if (typeof headRevision !== "number") throw new Error("missing head revision");

  const advanced = nextFrame(socket, (frame) =>
    frame.type === "session_page" &&
    typeof frame.headRevision === "number" &&
    frame.headRevision > headRevision);
  const secondTerminal = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "second" }));
  const next = await advanced;
  await secondTerminal;
  expect(next.afterRevision).toBe(headRevision);
  const actions = next.actions;
  if (!Array.isArray(actions)) throw new Error("missing authoritative action page");
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.every((action) => action !== null && typeof action === "object" &&
    !Array.isArray(action) && typeof action.revision === "number" &&
    action.revision > headRevision)).toBe(true);
});
